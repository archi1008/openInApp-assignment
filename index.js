const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const twilio = require('twilio');
const cron = require('node-cron');
require('dotenv').config();


const app = express();
app.use(bodyParser.json());

//My twilio Account Setup 
const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_TOKEN);

// MongoDB Atlas setup
mongoose.connect(process.env.MONGO_DB, {});

// MongoDB schemas
const taskSchema = new mongoose.Schema({
  title: String,
  description: String,
  due_date: Date,
  priority: Number,
  status: String,
  created_at: {
    type: Date,
    default: Date.now,
  },
  updated_at: {
    type: Date,
    default: Date.now,
  },
  deleted_at: {
    type: Date,
    default: null,
  },
});

const subTaskSchema = new mongoose.Schema({
    task_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
    },
    status: Number,
    created_at: {
      type: Date,
      default: Date.now,
    },
    updated_at: {
      type: Date,
      default: Date.now,
    },
    deleted_at: {
      type: Date,
      default: null,
    },
  });

const userSchema = new mongoose.Schema({
  phone_number: String,
  priority: Number,
});

const Task = mongoose.model('Task', taskSchema);
const SubTask = mongoose.model('SubTask', subTaskSchema);
const User = mongoose.model('User', userSchema);

//Cron Jobs
cron.schedule('0 0 * * *', async () => {
    try {
      // Find all tasks
      const tasks = await Task.find();
  
      // Update priority for each task based on due date
      tasks.forEach(async (task) => {
        task.priority = calculatePriority(task.due_date);
        await task.save();
      });
  
      console.log('Priority update cron job executed successfully.');
    } catch (error) {
      console.error('Error in priority update cron job:', error);
    }
  });

  cron.schedule('0 * * * *', async () => {
    try {
      // Find overdue tasks
      const overdueTasks = await Task.find({
        due_date: { $lt: new Date() },
        status: 'TODO', // Only call for tasks in 'TODO' status
      }).populate('user');
  
      // Sort tasks by user priority
      overdueTasks.sort((a, b) => a.user.priority - b.user.priority);
  
      // Initiate calls based on user priority
      for (const task of overdueTasks) {
        const phoneNumber = task.user.phone_number;
  
        // Initiate Twilio voice call
        await twilioClient.calls.create({
          url: 'http://demo.twilio.com/docs/voice.xml',
          from: process.env.TWILIO_PHONE_NO,
          to: phoneNumber, 
        });
  
        console.log(`Voice call initiated for user with priority ${task.user.priority}.`);
      }
  
      console.log('Voice call cron job executed successfully.');
    } catch (error) {
      console.error('Error in voice call cron job:', error);
    }
  });  

//Helper Functions
//For calculation of Task Status
const calculateStatus = async (taskId) => {
    try {
      // Find all subtasks for the given task
      const subtasks = await SubTask.find({ task_id: taskId });
  
      // Check if there are any incomplete subtasks
      const incompleteSubtasks = subtasks.some(subtask => subtask.status === 0);
  
      if (incompleteSubtasks) {
        // At least one subtask is incomplete
        return 'IN_PROGRESS';
      } else if (subtasks.length > 0) {
        // All subtasks are completed
        return 'DONE';
      } else {
        // No subtasks exist
        return 'TODO';
      }
    } catch (error) {
      console.error('Error calculating task status:', error);
      throw error;
    }
  };
  
  const calculatePriority = (due_date) => {
    const today = new Date();
    const dueDate = new Date(due_date);
    const timeDifference = dueDate.getTime() - today.getTime();
    const daysDifference = Math.ceil(timeDifference / (1000 * 3600 * 24));
  
    if (daysDifference === 0) {
      // Due date is today
      return 0;
    } else if (daysDifference >= 1 && daysDifference <= 2) {
      // Due date is between tomorrow and day after tomorrow
      return 1;
    } else if (daysDifference >= 3 && daysDifference <= 4) {
      // Due date is 3-4 days from now
      return 2;
    } else {
      // Due date is 5+ days from now
      return 3;
    }
  };

  const getFilteredTasks = async (filter, page, pageSize) => {
    try {
      const skip = (page - 1) * pageSize;
      const query = {};
  
      // Apply filters if they are present in the query
      if (filter.priority !== null) {
        query.priority = filter.priority;
      }
  
      if (filter.due_date !== null) {
        query.due_date = filter.due_date;
      }
  
      if (filter.status !== null) {
        query.status = filter.status;
      }
  
      const tasks = await Task.find(query)
        .skip(skip)
        .limit(Number(pageSize))
        .sort({ due_date: 1 });
  
      return tasks;
    } catch (error) {
      console.error('Error fetching tasks:', error);
      throw error;
    }
  };

  const getAllUserSubTasks = async (task_id = null,page,page_size) => {
    try {
      const skip = (page - 1) * page_size;
      const query = {};
  
      // Add task_id filter if provided
      if (task_id) {
        query.task_id = task_id;
      }
  
      const subTasks = await SubTask.find(query).skip(skip)
      .limit(Number(page_size));
      return subTasks;
    } catch (error) {
      console.error('Error fetching subtasks:', error);
      throw error;
    }
  };
  
// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization.replace('Bearer ','');
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized. Please add authorization token' });
  }

  jwt.verify(token, process.env.SECRET_KEY, (err, user) => {
    if (err) {
        console.error('Token verification error:', err);
      return res.status(403).json({ error: 'Authentication Failed. Please check your auth token' });
    }
    req.user = user;
    next();
  });
};

app.post('/api/users', async (req, res) => {
    try {
      const { phone_number, priority } = req.body;
      console.log("h",req.body);
      // Validation: Check if phone_number and priority are provided
      if (!phone_number || !priority) {
        return res.status(400).json({ error: 'Phone number and priority are required' });
      }
      const priorityInt = parseInt(priority);
      // Validation: Check if priority is a valid value (0, 1, or 2)
      if (![0, 1, 2].includes(priorityInt)) {
        return res.status(400).json({ error: 'Invalid priority value' });
      }
  
      // Create a new user
      const user = new User({
        phone_number,
        priorityInt,
      });
  
      // Save the user to the database
      await user.save();
  
      // Respond with the created user
      res.status(201).json(user);
    } catch (error) {
      console.error('Error creating user:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

app.post('/api/tasks', verifyToken, async (req, res) => {
  try {
    const { title, description, due_date } = req.body;
    const priority = calculatePriority(due_date);
    const status = 'TODO';
    const task = new Task({
      title,
      description,
      due_date,
      priority,
      status,
    });
    await task.save();
    res.status(201).json({"message":`The task ${title} created successfully`,task});
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Some error occured. Please recheck all the values' });
  }
});

  app.post('/api/subtasks', verifyToken, async (req, res) => {
    try {
      const { task_id } = req.body;
  
      // Validate if task_id exists
      const task = await Task.findById(task_id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
  
      const subTask = new SubTask({
        task_id,
        status: 0, // Assuming status 0 for incomplete
      });
  
      await subTask.save();
  
      res.status(201).json({"message":`The subtask created successfully`,subTask});
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Some error occured. Please recheck all the values' });
    }
  });
  
app.get('/api/gettasks', verifyToken, async (req, res) => {
  try {
    const filter = {
      priority: req.body.priority || null,
      due_date: req.body.due_date || null,
      status: req.body.status || null,
    };

    const tasks = await getFilteredTasks(filter, req.body.page, req.body.page_size);
    const message = tasks.length >0 ? "Here are the filtered tasks" : "No task found";
    res.status(200).json({message,tasks});
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

  app.get('/api/getsubtasks', verifyToken, async (req, res) => {
    try {
      const { task_id} = req.body;
  
      const SubTasks = await getAllUserSubTasks(task_id,req.body.page, req.body.page_size);
      const message = SubTasks.length >0 ? "Here are the filtered subtasks" : "No task found";
      res.status(200).json({message,SubTasks});
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });
  // Get all user subtasks with optional task_id filter


  app.put('/api/tasks/:taskId', verifyToken, async (req, res) => {
    try {
      const { taskId } = req.params;
      const { due_date, status } = req.body;
  
      // Validate if taskId exists
      const task = await Task.findById(taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
  
      // Update task properties
      if (due_date) {
        task.due_date = due_date;
        task.priority = calculatePriority(due_date);
      }
  
      if (status) {
        task.status = status;
      }
      task.updated_at = new Date();
      await task.save();
  
      // Update corresponding subtasks
      await SubTask.updateMany({ task_id: taskId }, { $set: { status: status === 'DONE' ? 1 : 0 } });
  
      res.status(200).json({ message: 'Task Updated Successfully', task });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Some error occurred. Please check values again' });
    }
  });
  

  app.put('/api/subtasks/:subtaskId', verifyToken, async (req, res) => {
    try {
      const { subtaskId } = req.params;
      const { status } = req.body;
  
      const subTask = await SubTask.findById(subtaskId);
      if (!subTask) {
        return res.status(404).json({ error: 'Subtask not found' });
      }
  
      subTask.status = status;
      subTask.updated_at = new Date();
      const myTask = await Task.findById(subTask.task_id);
      myTask.status = calculateStatus(subTask.task_id);
      await subTask.save();
  
      res.status(200).json({"message":"Subtask Updated Successfully",subTask});
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Some error occured. Please check values again' });
    }
  });
  // API to soft delete a task
app.delete('/api/tasks/:taskId', verifyToken, async (req, res) => {
    try {
      const { taskId } = req.params;
      const task = await Task.findById(taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      task.deleted_at = new Date();
      await task.save();
      await SubTask.updateMany({ task_id: taskId }, { $set: { deleted_at: new Date() } });
  
      res.status(200).json({"message":"Task Deleted Successfully"});
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Some error occured. Please check values again' });
    }
  });
  
  // API to soft delete a subtask
app.delete('/api/subtasks/:subtaskId', verifyToken, async (req, res) => {
    try {
      const { subtaskId } = req.params;
      const subTask = await SubTask.findById(subtaskId);
      if (!subTask) {
        return res.status(404).json({ error: 'Subtask not found' });
      }
  
      subTask.deleted_at = new Date();
      await subTask.save();
  
      res.status(200).json({"message":"SubTask Deleted Successfully"}); // 204 No Content
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Some error occured. Please check values again' });
    }
  });
  
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
