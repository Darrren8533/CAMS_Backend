const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require("google-auth-library");
const client = new OAuth2Client("671845549558-ceaj5qh7romftff7r5cocnckuqo17cd0.apps.googleusercontent.com");
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const {PGHOST, PGDATABASE, PGUSER, PGPASSWORD} = process.env;
const port = 5432;

const pool = new Pool({
  host: PGHOST,
  database: PGDATABASE,
  user: PGUSER,
  password: PGPASSWORD,
  port: 5432,  // 修正为 PostgreSQL 默认端口
  ssl: {
    require: true,
  },
  // 添加超时设置
  connectionTimeoutMillis: 5000,
  query_timeout: 5000
})

const app = express();

app.get('/', async(req, res) => {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query("SELECT * FROM users");
    // const result = await pool.connect.query("SELECT * FROM users");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error', success: false });
  } finally {
    if (client) {
      client.release();
    }
  }
});

app.use(express.json());
app.use(cors());

// Set up multer for file uploads with memory storage and size limits
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
      fieldSize: 25 * 1024 * 1024, 
      fileSize: 25 * 1024 * 1024  
  }
});

//Database configuration
// const dbConfig = {
//   user: 'sa',
//   password: 'CAMS',
//   server: 'WILSON1684',
//   database: 'CAMS_DB',
//   options: {
//     encrypt: false,
//     enableArithAbort: true,
//   },
// };

// Initialize database connection pool
// let pool;
// const initDbConnection = async () => {
//   try {
//     pool = await sql.connect(dbConfig);
//     console.log('Database connected successfully');
//   } catch (err) {
//     console.error('Error connecting to the database:', err);
//   }
// };
// initDbConnection();

// Close database connection pool on server shutdown
process.on('SIGINT', async () => {
  if (pool) {
    try {
      await pool.close();
      console.log('Database connection pool closed');
    } catch (err) {
      console.error('Error closing the connection pool:', err);
    }
  }
  process.exit();
});



// Registration
app.post('/register', async (req, res) => {
  const { firstName, lastName, username, password, email } = req.body;
  let client;
  
  try {
    client = await pool.connect();
    // 检查用户名或邮箱是否已存在
    const checkUserQuery = {
      text: `
        SELECT username, uemail FROM users
        WHERE username = $1 OR uemail = $2
      `,
      values: [username, email]
    };
    
    const checkResult = await client.query(checkUserQuery);
    
    if (checkResult.rows.length > 0) {
      return res.status(409).json({ message: 'Username or email already exists', success: false });
    }
    
    // 获取默认头像
    const defaultAvatarBase64 = await getDefaultAvatarBase64();
    
    // 插入新用户
    const insertUserQuery = {
      text: `
        INSERT INTO users (
          username, password, uemail, utitle, usergroup, ustatus, uactivation, uimage,
          ufirstname, ulastname
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      values: [
        username,
        password,
        email,
        "Mr.",
        'Customer',
        'registered',
        'Active',
        defaultAvatarBase64,
        firstName, // 添加 firstName
        lastName   // 添加 lastName
      ]
    };
    
    await client.query(insertUserQuery);
    
    res.status(201).json({ message: 'User registered successfully', success: true });
  } catch (err) {
    console.error('Error during registration:', err.message);
    console.error(err.stack);
    res.status(500).json({ message: 'Server error', success: false });
  } finally {
    
    if (client) {
      client.release();
    }
  }
});

//Login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  let client;

  try {
    client = await pool.connect();
    
    // 使用 PostgreSQL 语法
    const result = await client.query(
      `SELECT userid, usergroup, uactivation 
       FROM users 
       WHERE (username = $1 OR uemail = $1) 
       AND password = $2`,
      [username, password]
    );

    if (result.rows.length > 0) {
      const { userid, usergroup, uactivation } = result.rows[0];

      // 更新用户状态
      await client.query(
        `UPDATE users
         SET ustatus = 'login' 
         WHERE username = $1 OR uemail = $1`,
        [username]
      );

      res.status(200).json({
        message: 'Login Successful',
        success: true,
        userid: userid, 
        usergroup: usergroup,
        uactivation: uactivation 
      });
    } else {
      res.status(401).json({ message: 'Invalid username or password', success: false });
    }
  } catch (err) {
    console.error('Error during login:', err);
    res.status(500).json({ message: 'Server error', success: false });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Google login
app.post("/google-login", async (req, res) => {
  const { token } = req.body;

  try {
    // Get user info from Google
    const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const googleUser = await response.json();

    if (!googleUser.email) {
      return res.status(401).json({ success: false, message: "Invalid Google token" });
    }

    const { email, given_name, family_name, picture } = googleUser;
    console.log("Google User Data:", googleUser);

    const client = await pool.connect();

    try {
      // Check if user exists
      const result = await client.query(
        "SELECT userid, usergroup, uactivation, username FROM users WHERE uemail = $1",
        [email]
      );

      let username;
      if (result.rows.length > 0) {
        // Existing user, update login status
        const { userid, usergroup, uactivation, username: existingUsername } = result.rows[0];
        username = existingUsername;

        await client.query("UPDATE users SET ustatus = 'login' WHERE uemail = $1", [email]);

        return res.status(200).json({
          success: true,
          message: "Google Login Successful",
          userid: userid,
          usergroup: usergroup,
          uactivation: uactivation,
          username,
        });
      } else {
        const randomSixDigits = generateRandomSixDigits();
        username = given_name ? `${given_name}_${randomSixDigits}` : `user_${randomSixDigits}`;

        // Insert new Google user
        const insertResult = await client.query(
          `INSERT INTO users (uemail, ufirstname, ulastname, uimage, utitle, ustatus, usergroup, uactivation, username)
           VALUES ($1, $2, $3, $4, 'Mr.', 'login', 'Customer', 'Active', $5) 
           RETURNING userid`,
          [email, given_name || null, family_name || null, picture || null, username]
        );

        const newuserid = insertResult.rows[0].userid;

        return res.status(201).json({
          success: true,
          message: "Google Login Successful, new user created",
          userid: newuserid,
          usergroup: "Customer",
          uactivation: "Active",
          username,
        });
      }
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Google Login Error:", error);
    return res.status(500).json({ success: false, message: "Google Login Failed" });
  }
});

// 用户退出登录端点
app.post('/logout', async (req, res) => {
  const { userid } = req.body;
  let client;

  try {
    client = await pool.connect();
    
    // 更新用户状态为已登出
    const query = {
      text: `UPDATE users SET ustatus = 'logout' WHERE userid = $1`,
      values: [userid]
    };
    
    await client.query(query);

    res.status(200).json({ message: 'Logout Successful', success: true });
  } catch (err) {
    console.error('Error during logout:', err);
    res.status(500).json({ message: 'Server error', success: false });
  } finally {
    // 确保释放数据库连接
    if (client) {
      client.release();
    }
  }
});

app.get('/users/customers', async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(`
      SELECT userid, ufirstname, ulastname, uemail, uphoneno, ucountry, uzipcode, uactivation, ugender, utitle
      FROM users
      WHERE usergroup = 'Customer'
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching customers:', err);
    res.status(500).json({ message: 'Server error', success: false });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Fetch list of owners
app.get('/users/owners', async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(`
      SELECT userid, ufirstname, ulastname, uemail, uphoneno, ucountry, uzipcode, uactivation, ugender, utitle
      FROM users
      WHERE usergroup = 'Owner'
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching owners:', err);
    res.status(500).json({ message: 'Server error', success: false });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Fetch list of moderators
app.get('/users/moderators', async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    // Query to fetch moderators
    const result = await client.query(`
      SELECT userid, ufirstname, ulastname, uemail, uphoneno, ucountry, uzipcode, uactivation, ugender, utitle
      FROM users
      WHERE usergroup = 'Moderator'
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching moderators:', err);
    res.status(500).json({ message: 'Server error', success: false });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Fetch list of operators (Moderators and Administrators)
app.get('/users/operators', async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(`
      SELECT userid, username, ufirstname, ulastname, uemail, uphoneno, usergroup, uactivation, ugender, ucountry, uzipcode, utitle
      FROM users
      WHERE usergroup IN ('Moderator', 'Administrator')
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching operators:", err);
    res.status(500).json({ message: "Server error", success: false });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Fetch list of administrators
app.get('/users/administrators', async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(`
      SELECT userid, ufirstname, ulastname, uemail, uphoneno, ucountry, uzipcode, uactivation, ugender, utitle
      FROM users
      WHERE usergroup = 'Administrator'
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching administrators:', err);
    res.status(500).json({ message: 'Server error', success: false });
  } finally {
    if (client) {
      client.release();
    }
  }
});


// Create moderators
app.post('/users/createModerator', async (req, res) => {
  const { firstName, lastName, username, password, email, phoneNo, country, zipCode } = req.body;
  let client;

  try {
    client = await pool.connect();

    // Check if the username or email already exists
    const checkUser = await client.query(
      `SELECT username, uemail FROM users WHERE username = $1 OR uemail = $2`,
      [username, email]
    );

    if (checkUser.rows.length > 0) {
      return res.status(409).json({ message: "Username or email already exists", success: false });
    }

    // Insert new user into the database
    await client.query(
      `INSERT INTO users (ufirstname, ulastname, username, password, uemail, uphoneno, ucountry, uzipcode, utitle, usergroup, ustatus, uactivation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Mr.', 'Moderator', 'registered', 'Active')`,
      [firstName, lastName, username, password, email, phoneNo, country, zipCode]
    );

    res.status(201).json({ message: "User registered successfully", success: true });

  } catch (err) {
    console.error("Error during registration:", err);
    res.status(500).json({ message: "Server error", success: false });
  } finally {
    if (client) client.release();
  }
});

// Update users by user ID
app.put('/users/updateUser/:userid', async (req, res) => {
  const { userid } = req.params;
  const { firstName, lastName, username, email, phoneNo, country, zipCode } = req.body;

  try {
      // 使用参数化查询更新用户信息
      const query = `
          UPDATE users
          SET ufirstname = $1, 
              ulastname = $2, 
              username = $3, 
              uemail = $4,
              uphoneno = $5,
              ucountry = $6,
              uzipcode = $7
          WHERE userid = $8
      `;

      const values = [firstName, lastName, username, email, phoneNo, country, zipCode, userid];

      await pool.query(query, values);

      console.log(`
      UPDATE users
      SET ufirstname = '${firstName}', 
          ulastname = '${lastName}', 
          username = '${username}', 
          uemail = '${email}',
          uphoneno = '${phoneNo}',
          ucountry = '${country}',
          uzipcode = '${zipCode}'
      WHERE userid = '${userid}'
      `);

      res.status(200).json({ message: 'User updated successfully' });
  } catch (err) {
      console.error('Error updating user:', err);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});


// Remove users by user ID
app.delete('/users/removeUser/:userid', async (req, res) => {
  const { userid } = req.params;
  let client;
  
  try {
    client = await pool.connect();
    
    // Check if the user exists
    const userCheck = await client.query(
      'SELECT userid FROM users WHERE userid = $1',
      [userid]
    );
    
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: 'User not found', success: false });
    }
    
    // Delete the user
    await client.query(
      'DELETE FROM users WHERE userid = $1',
      [userid]
    );
    
    res.status(200).json({ message: 'User removed successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ message: 'Server error', success: false });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Suspend users by user ID
app.put('/users/suspenduser/:userid', async (req, res) => {
  const { userid } = req.params;
  let client;

  // Validate userid
  if (isNaN(userid)) {
    return res.status(400).json({ message: 'Invalid userid' });
  }

  try {
    client = await pool.connect();

    // Check if the user exists
    const userCheck = await client.query(
      `SELECT userid FROM users WHERE userid = $1`,
      [userid]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Suspend the user
    await client.query(
      `UPDATE users SET uactivation = 'Inactive' WHERE userid = $1`,
      [userid]
    );

    res.status(200).json({ message: 'User suspended successfully' });
  } catch (err) {
    console.error('Error suspending user:', err);
    res.status(500).json({ message: 'Server error', success: false });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Activate users by userid
app.put('/users/activateuser/:userid', async (req, res) => {
  const { userid } = req.params;
  let client;

  // Validate userid
  if (isNaN(userid)) {
    return res.status(400).json({ message: 'Invalid userid' });
  }

  try {
    client = await pool.connect();

    // Check if the user exists
    const userCheck = await client.query(
      `SELECT userid FROM users WHERE userid = $1`,
      [userid]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Activate the user
    await client.query(
      `UPDATE users SET uactivation = 'Active' WHERE userid = $1`,
      [userid]
    );

    res.status(200).json({ message: 'User activated successfully' });
  } catch (err) {
    console.error('Error activating user:', err);
    res.status(500).json({ message: 'Server error', success: false });
  } finally {
    if (client) {
      client.release();
    }
  }
});

app.post('/propertiesListing', upload.array('propertyImage', 10), async (req, res) => {
  const {
      username,
      propertyPrice,
      propertyAddress,
      clusterName,
      categoryName,
      propertyBedType,
      propertyGuestPaxNo,
      propertyDescription,
      nearbyLocation,
      facilities
  } = req.body;

  if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Please upload at least 5 property images.' });
  }

  let client;
  try {
      client = await pool.connect();
      await client.query('BEGIN');

      // Fetch user ID and userGroup for property owner
      const userResult = await client.query(
          'SELECT userid, usergroup FROM users WHERE username = $1',
          [username]
      );

      if (userResult.rows.length === 0) {
          return res.status(404).json({ error: 'User not found' });
      }

      const { userid, usergroup } = userResult.rows[0];

      // Determine propertyStatus based on userGroup
      const propertyStatus = usergroup === 'Administrator' ? 'Available' : 'Pending';

      // Convert images to base64 and concatenate them
      const base64Images = req.files.map(file => file.buffer.toString('base64'));
      const concatenatedImages = base64Images.join(',');

      // Insert rate
      const rateResult = await client.query(
          `INSERT INTO rate (rateamount, ratetype, period)
           VALUES ($1, $2, $3)
           RETURNING rateid`,
          [propertyPrice, "DefaultType", "DefaultPeriod"]
      );
      const rateID = rateResult.rows[0].rateid;

      // 先检查集群是否存在
      let clusterID;
      const existingCluster = await client.query(
          'SELECT clusterid FROM clusters WHERE clustername = $1',
          [clusterName]
      );
      
      if (existingCluster.rows.length > 0) {
          clusterID = existingCluster.rows[0].clusterid;
      } else {
          // 如果集群不存在，才创建新的
          const clusterResult = await client.query(
              `INSERT INTO clusters (clustername, clusterstate, clusterprovince)
               VALUES ($1, $2, $3)
               RETURNING clusterid`,
              [clusterName, "DefaultState", "DefaultProvince"]
          );
          clusterID = clusterResult.rows[0].clusterid;
      }

      // 同样检查类别是否存在
      let categoryID;
      const existingCategory = await client.query(
          'SELECT categoryid FROM categories WHERE categoryname = $1',
          [categoryName]
      );

      if (existingCategory.rows.length > 0) {
          categoryID = existingCategory.rows[0].categoryid;
      } else {
          // 如果类别不存在，才创建新的
          const categoryResult = await client.query(
              `INSERT INTO categories (categoryname, availablestates)
               VALUES ($1, $2)
               RETURNING categoryid`,
              [categoryName, "DefaultStates"]
          );
          categoryID = categoryResult.rows[0].categoryid;
      }

      // Insert property
      const propertyListingResult = await client.query(
          `INSERT INTO properties (
              propertyno, userid, clusterid, categoryid, rateid,
              propertydescription, propertyaddress,
              propertybedtype, propertybedimage, propertyguestpaxno, propertyimage,
              propertystatus, nearbylocation, facilities, policies
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          RETURNING propertyid`,
          [
              "1", userid, clusterID, categoryID, rateID,
              propertyDescription, propertyAddress,
              propertyBedType, "1", propertyGuestPaxNo, concatenatedImages,
              propertyStatus, nearbyLocation, facilities, "policies"
          ]
      );

      const propertyid = propertyListingResult.rows[0].propertyid;
      
      // 提交事务
      await client.query('COMMIT');

      res.status(201).json({ message: 'Property created successfully', propertyid });
  } catch (err) {
      // 回滚事务
      if (client) {
        await client.query('ROLLBACK');
      }
      console.error('Error inserting property: ', err);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
  } finally {
      // 释放连接
      if (client) {
        client.release();
      }
  }
});

// Fetch list of all property listings (Product)
app.get('/product', async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    
    const query = `
      SELECT p.*, u.username, r.rateamount, c.categoryname 
      FROM properties p
      JOIN rate r ON p.rateid = r.rateid
      JOIN categories c ON p.categoryid = c.categoryid
      JOIN users u ON p.userid = u.userid
      WHERE p.propertystatus = 'Available'
    `;
    
    const result = await client.query(query);
    
    // 打印原始查询结果中的第一个属性对象(如果存在)
    if (result.rows.length > 0) {
      console.log('Sample property object from database:');
      console.log(JSON.stringify(result.rows[0], null, 2));
    } else {
      console.log('No properties found');
    }
    
    const properties = result.rows.map(property => {
      // 处理图片并打印处理前后的图片数据
      console.log(`Property ID ${property.propertyid} - Original image data:`, 
                  property.propertyimage ? property.propertyimage.substring(0, 50) + '...' : 'No image');
      
      const processedProperty = {
        ...property,
        propertyimage: property.propertyimage ? property.propertyimage.split(',') : []
      };
      
      console.log(`Property ID ${property.propertyid} - Processed image array length:`, 
                  processedProperty.propertyimage.length);
      
      return processedProperty;
    });
    
    // 打印处理后的第一个属性对象(如果存在)
    if (properties.length > 0) {
      console.log('Sample processed property object:');
      // 克隆对象并截断图片数据以避免日志过大
      const sampleProperty = {...properties[0]};
      if (sampleProperty.propertyimage && sampleProperty.propertyimage.length > 0) {
        sampleProperty.propertyimage = [`${sampleProperty.propertyimage[0].substring(0, 50)}... (truncated)`, 
                                       `and ${sampleProperty.propertyimage.length - 1} more images`];
      }
      console.log(JSON.stringify(sampleProperty, null, 2));
    }
    
    res.status(200).json(properties);
  } catch (err) {
    console.error('Error fetching properties: ', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Fetch list of all property listings (Dashboard)
app.get('/propertiesListingTable', async (req, res) => {
  const username = req.query.username;

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  let client;
  try {
    client = await pool.connect();
    
    // 查询用户信息
    const userResult = await client.query(
      'SELECT userid, usergroup FROM users WHERE username = $1',
      [username]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userid = userResult.rows[0].userid;
    const usergroup = userResult.rows[0].usergroup;

    let query;

    if (usergroup === 'Moderator') {
      // Moderator 只能看到自己的属性
      query = `
        SELECT 
          p.propertyid, 
          p.propertyaddress, 
          p.nearbylocation,
          p.propertybedtype, 
          p.propertyguestpaxno, 
          p.propertydescription, 
          p.propertystatus, 
          p.propertyimage,
          u.ufirstname, 
          u.ulastname,
          u.username,
          r.rateamount,
          cl.clustername,
          c.categoryname
        FROM properties p
        JOIN users u ON p.userid = u.userid
        JOIN rate r ON p.rateid = r.rateid
        JOIN clusters cl ON p.clusterid = cl.clusterid
        JOIN categories c ON p.categoryid = c.categoryid
        WHERE p.userid = $1
      `;
    } else {
      // Administrator 可以看到所有属性
      query = `
        SELECT 
          p.propertyid, 
          p.propertyaddress, 
          p.nearbylocation,
          p.propertybedtype, 
          p.propertyguestpaxno, 
          p.propertydescription, 
          p.propertystatus, 
          p.propertyimage,
          u.ufirstname, 
          u.ulastname,
          u.username,
          r.rateamount,
          cl.clustername,
          c.categoryname
        FROM properties p
        JOIN users u ON p.userid = u.userid
        JOIN rate r ON p.rateid = r.rateid
        JOIN clusters cl ON p.clusterid = cl.clusterid
        JOIN categories c ON p.categoryid = c.categoryid
      `; // 移除 WHERE 条件，这样管理员可以看到所有属性
    }

    // 相应地修改查询参数
    const params = usergroup === 'Moderator' ? [userid] : [];
    const result = await client.query(query, params);

    const properties = result.rows.map(property => ({
      ...property,
      propertyimage: property.propertyimage ? property.propertyimage.split(',') : []
    }));

    res.status(200).json({ properties });
  } catch (err) {
    console.error('Error fetching properties: ', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Update an existing property listing by property ID
app.put('/propertiesListing/:propertyid', upload.array('propertyImage', 10), async (req, res) => {
  const { propertyid } = req.params;
  const {
      propertyAddress, propertyPrice, propertyDescription, nearbyLocation,
      propertyBedType, propertyGuestPaxNo, clusterName, categoryName
  } = req.body;

  const removedImages = req.body.removedImages ? JSON.parse(req.body.removedImages) : [];

  try {
      const pool = await sql.connect(dbConfig);

      // Fetch the current status of the property
      const propertyResult = await pool.request()
          .input('propertyid', sql.Int, propertyid)
          .query('SELECT propertyStatus, propertyImage FROM Properties WHERE propertyid = @propertyid');

      if (propertyResult.recordset.length === 0) {
          return res.status(404).json({ error: 'Property not found' });
      }

      const currentStatus = propertyResult.recordset[0].propertyStatus;

      let existingImages = propertyResult.recordset[0].propertyImage
          ? propertyResult.recordset[0].propertyImage.split(',')
          : [];

      // Filter out removed images
      existingImages = existingImages.filter(image => !removedImages.includes(image));

      // Add new uploaded images if any
      if (req.files && req.files.length > 0) {
          const newBase64Images = req.files.map(file => file.buffer.toString('base64'));
          existingImages = [...existingImages, ...newBase64Images];
      }

      const concatenatedImages = existingImages.join(',');

      // Update the property
      await pool.request()
          .input('propertyid', sql.Int, propertyid)
          .input('propertyAddress', sql.VarChar, propertyAddress)
          .input('nearbyLocation', sql.VarChar, nearbyLocation)
          .input('propertyBedType', sql.VarChar, propertyBedType)
          .input('propertyBedImage', sql.VarChar(sql.MAX), "1")
          .input('propertyGuestPaxNo', sql.VarChar, propertyGuestPaxNo)
          .input('propertyDescription', sql.VarChar, propertyDescription)
          .input('propertyImage', sql.VarChar(sql.MAX), concatenatedImages)
          .query(`
              UPDATE Properties 
              SET propertyDescription = @propertyDescription, 
                  propertyAddress = @propertyAddress, 
                  nearbyLocation = @nearbyLocation, 
                  propertyBedType = @propertyBedType, 
                  propertyGuestPaxNo = @propertyGuestPaxNo, 
                  propertyImage = @propertyImage
              WHERE propertyid = @propertyid
          `);

        await pool.request()
          .input('rateID', sql.Int, rateID)
          .input('rateAmount', sql.Decimal(18, 2), propertyPrice)
          .query(`
              UPDATE Rate 
              SET rateAmount = @rateAmount
              WHERE rateID = @rateID
          `);

        await pool.request()
          .input('clusterID', sql.Int, rateID)
          .input('clusterName', sql.VarChar, clusterName)
          .query(`
              UPDATE Clusters
              SET clusterName = @clusterName
              WHERE clusterID = @clusterID
          `);

        await pool.request()
          .input('categoryID', sql.Int, rateID)
          .input('categoryName', sql.VarChar, categoryName)
          .query(`
              UPDATE Categories 
              SET categoryName = @categoryName
              WHERE categoryID = @categoryID
          `);

      res.status(200).json({ message: 'Property updated successfully' });
  } catch (err) {
      console.error('Error updating property:', err);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

// Update Property Status API
app.patch("/updatePropertyStatus/:propertyid", async (req, res) => {
  const { propertyid } = req.params;
  const { propertyStatus } = req.body;  // 修改这里：propertystatus -> propertyStatus

  if (!propertyStatus) {
    return res.status(400).json({ message: "Property status is required" });
  }

  let client;
  try {
    client = await pool.connect(); 
    const result = await client.query(
      'UPDATE properties SET propertystatus = $1 WHERE propertyid = $2 RETURNING *',
      [propertyStatus, propertyid]  // 这里使用新的变量名
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Property not found" });
    }

    res.status(200).json({ message: "Property status updated successfully", property: result.rows[0] });
  } catch (error) {
    console.error("Error updating property status:", error);
    res.status(500).json({ message: "Internal Server Error" });
  } finally {
    if (client) {
      client.release(); 
    }
  }
});


app.delete('/propertiesListing/:propertyid', async (req, res) => {
  const { propertyid } = req.params;
  let client;

  try {
    client = await pool.connect();

    // Check if the property exists
    const propertyCheck = await client.query(
      'SELECT propertyid FROM "Properties" WHERE propertyid = $1',
      [propertyid]
    );

    if (propertyCheck.rowCount === 0) {
      return res.status(404).json({ message: 'Property not found', success: false });
    }

    // Delete the property from the database
    await client.query(
      'DELETE FROM "Properties" WHERE propertyid = $1',
      [propertyid]
    );

    res.status(200).json({ message: 'Property deleted successfully', success: true });
  } catch (err) {
    console.error('Error deleting property:', err);
    res.status(500).json({ message: 'Internal Server Error'});
  } finally {
    if (client) {
      client.release();
    }
  }
});


// Check user status by userID
app.get('/checkStatus', async(req, res) => {
  const { userid } = req.query;
  let client;

  // 打印接收到的userID参数
  console.log('Received userID parameter:', userid);
  console.log('Full query parameters:', req.query);

  try {
    client = await pool.connect();
    
    // 修改查询，获取更多用户信息
    const query = {
      text: 'SELECT userid, username, ustatus, uemail, ufirstname, ulastname FROM "users" WHERE "userid" = $1',
      values: [userid]
    };
    
    const result = await client.query(query);

    // 打印完整结果对象
    console.log('Full result object:', result);
    
    // 如果只想查看行数据
    console.log('Rows:', result.rows);
    
    if (result.rows.length > 0) {
      const user = result.rows[0];
      console.log('User information:', user); // 在服务器端打印用户信息
      res.status(200).json({ 
        ustatus: user.ustatus,
        userInfo: user  // 可选：同时返回用户信息给客户端
      });
    } else {
      console.log('User not found for ID:', userid);
      res.status(404).json({ message: 'User not found' });
    }
  } catch (err) {
    console.error('Error fetching user status:', err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    // 确保释放数据库连接
    if (client) {
      client.release();
    }
  }
});

// Send contact us email
app.post("/contact_us", async (req, res) => {
  const { name, email, message } = req.body;
  let client;

  try {
    client = await pool.connect(); 

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "omg71933@gmail.com",
        pass: "eyiwkkdsklngzzzj",
      },
    });

    const mailOptions = {
      from: "omg71933@gmail.com",
      to: "omg71933@gmail.com",
      subject: `Message from ${name}`,
      html: `
      <h1>New Message from ${name}</h1>
      <p><strong>Message:</strong></p>
      <p>${message}</p>
      <p><strong>Email:</strong> ${email}</p>`,
      replyTo: email,
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: "Email sent successfully" });
  } catch (error) {
    console.error("Error sending email:", error);
    res.status(500).json({ message: "Failed to send email", error: error.message });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Send Booking Request Message To Administrator Or Moderator
app.post('/requestBooking/:reservationid', async (req, res) => {
  const { reservationid } = req.params;

  try {
    const result = await pool.request()
      .input('reservationid', sql.Int, reservationid)
      .query(`SELECT rc.rclastname, rc.rctitle, r.propertyidcheckindatetime, r.checkoutdatetime, r.request, r.totalprice, p.propertyAddress, u.uemail FROM Reservation_Customer_Details rc JOIN Reservation r ON rc.rcID = r.rcID JOIN Properties p ON r.propertyid = p.propertyid JOIN users u ON u.userid = p.userid WHERE reservationid = @reservationid`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: 'Reservation or user not found for this property' });
    }

    const { rclastname: customerLastName, rctitle: customerTitle, propertyidcheckindatetime: reservationpropertyidcheckindatetime, checkoutdatetime: reservationcheckoutdatetime, request: reservationRequest = '-', totalprice: reservationtotalprice, propertyAddress: reservationProperty, uemail: userEmail } = result.recordset[0];

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'laudarren911@gmail.com',
        pass: 'tlld oplc qepx hbzy',
      },
    });

    const mailOptions = {
      from: 'laudarren911@gmail.com',
      to: userEmail,
      subject: 'Booking Request',
      html: `
      <h1><b>Do You Accept This Booking By ${customerTitle} ${customerLastName}?</b></h1><hr/>
      <p><b>Check In Date:</b> ${reservationpropertyidcheckindatetime}</p>
      <p><b>Check Out Date:</b> ${reservationcheckoutdatetime}</p>
      <p><b>Pax Number:</b> ${reservationPaxNumber}</p>
      <p><b>Request:</b> ${reservationRequest}</p>
      <p><b>Property Name:</b> ${reservationProperty}</p>
      <p><b>Total Price: <i>RM${reservationtotalprice}</i></b></p><br/>
      <p><b>Please kindly click the button below to make the decision in <b>12 hours</b> time frame.</b></p>
      <div style="margin: 10px 0;">
        <a href="" style="background-color: green; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-right: 10px;">Accept</a>
        <a href="" style="background-color: red; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Reject</a>
      </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Email Sent Successfully' })
  } catch (err) {
    console.error('Error sending email: ', err);
    res.status(500).json({ message: 'Failed to send email', error: err.message });
  }
});

// Send Booking Request Accepted Message To Customer
app.post('/accept_booking/:reservationid', async (req, res) => {
  const { reservationid } = req.params;

  try {
    const result = await pool.request()
      .input('reservationid', sql.Int, reservationid)
      .query(`SELECT rc.rclastname, rc.rcemail, rc.rctitle, r.propertyidcheckindatetime, r.checkoutdatetime, r.reservationblocktime, p.propertyAddress FROM Reservation_Customer_Details rc JOIN Reservation r ON rc.rcID = r.rcID JOIN Properties p ON r.propertyid = p.propertyid WHERE reservationid = @reservationid`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: 'Reservation customer or property not found for this reservation' });
    }

    const { rclastname: customerLastName, rcemail: customerEmail, rctitle: customerTitle, propertyidcheckindatetime: reservationCheckInDate, checkoutdatetime: reservationCheckOutDate, reservationblocktime: paymentDueDate, propertyAddress: reservationProperty } = result.recordset[0];

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'laudarren911@gmail.com',
        pass: 'tlld oplc qepx hbzy',
      },
    });

    const mailOptions = {
      from: 'laudarren911@gmail.com',
      to: customerEmail,
      subject: 'Booking Accepted',
      html: `
      <h1><b>Dear ${customerTitle} ${customerLastName},</b></h1><hr/>
      <p>Your booking for <b>${reservationProperty}</b> from <b>${reservationCheckInDate}</b> to <b>${reservationCheckOutDate}</b> has been <span style="color: green">accepted</span>.</p> 
      <p>Please kindly click the button below to make payment before <b>${paymentDueDate}</b> to secure your booking.</p>  
      <a href="" style="background-color: blue; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-right: 10px;">Pay</a>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Email Sent Successfully' })
  } catch (err) {
    console.error('Error sending email: ', err);
    res.status(500).json({ message: 'Failed to send email', error: err.message });
  }
});

// Send New Room Suggestion To Customer
app.post('/suggestNewRoom/:propertyid/:reservationid', async (req, res) => {
  const { propertyid, reservationid } = req.params;

  try {
    const result = await pool.request()
      .input('propertyid', sql.Int, propertyid)
      .query(`SELECT propertyAddress, propertyPrice, propertyLocation, propertyBedType, propertyGuestPaxNo FROM Property WHERE propertyid = @propertyid`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: 'Property not found for suggestion' });
    }

    const property = result.recordset[0];

    const { propertyAddress: suggestpropertyAddress, propertyPrice: suggestPropertyPrice, propertyLocation: suggestPropertyLocation, propertyBedType: suggestPropertyBedType, propertyGuestPaxNo: suggestPropertyGuestPaxNo } = property;

    const customerReservationResult = await pool.request()
      .input('reservationid', sql.Int, reservationid)
      .query(`SELECT rc.rclastname, rc.rcemail, rc.rctitle, p.propertyAddress, r.propertyidcheckindatetime, r.checkoutdatetime FROM Reservation r JOIN Properties p ON p.propertyid = r.propertyid JOIN Reservation_Customer_Details rc ON rc.rcID = r.rcID WHERE reservationid = @reservationid`);

    if (customerReservationResult.recordset.length === 0) {
      return res.status(404).json({ message: 'User email not found for suggestion' });
    }

    const { rclastname: customerLastName, rcemail: customerEmail, rctitle: customerTitle, propertyAddress: reservationProperty, propertyidcheckindatetime: reservationCheckInDate, checkoutdatetime: reservationCheckOutDate } = customerReservationResult.recordset[0];

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'laudarren911@gmail.com',
        pass: 'tlld oplc qepx hbzy',
      },
    });

    const mailOptions = {
      from: 'laudarren911@gmail.com',
      to: customerEmail,
      subject: 'Booking Request Rejected & New Room Suggestion',
      html: `
      <h1><b>Dear ${customerTitle} ${customerLastName},</b></h1><hr/>
      <p>Your booking for <b>${reservationProperty}</b> from <b>${reservationCheckInDate}</b> to <b>${reservationCheckOutDate}</b> has been <span style="color: red">rejected</span> due to room unavailable during the time selected.</p> 
      <p>A similar room with the details below is suggested for consideration:</p> 
      <h3>Property Name: ${suggestpropertyAddress}</h3>
      <p><b>Property Location:</b> ${suggestPropertyLocation}</p>
      <p><b>Bed Type:</b> ${suggestPropertyBedType}</p>
      <p><b>Pax Number:</b> ${suggestPropertyGuestPaxNo}</p>
      <p><b>Price: <i>RM${suggestPropertyPrice}</i></b></p><br/>
      <p>Please kindly make your decision by clicking the buttons below</p>
      <div style="margin: 10px 0;">
        <a href="" style="background-color: blue; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-right: 10px;">Pay</a>
        <a href="" style="background-color: red; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Reject</a>
      </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Email Sent Successfully' })
  } catch (err) {
    console.error('Error sending email: ', err);
    res.status(500).json({ message: 'Failed to send email', error: err.message });
  }
});

// Send Properties Listing Request Notification From Moderator
app.post('/propertyListingRequest/:propertyid', async (req, res) => {
  const { propertyid } = req.params;
  let client;

  try {
    client = await pool.connect();
    
    const moderatorResult = await client.query(
      `SELECT p.propertyaddress, u.ulastname, u.utitle, u.usergroup 
       FROM property p 
       JOIN users u ON u.userid = p.userid 
       WHERE p.propertyid = $1`,
      [propertyid]
    );

    if (moderatorResult.rows.length === 0) {
      return res.status(404).json({ message: 'Property or moderator not found for this property listing request' });
    } else if (moderatorResult.rows[0].usergroup !== 'Moderator') {
      return res.status(200).json({ message: 'Property Created Successfully' });
    }

    const { propertyaddress: property, ulastname: moderatorLastName, utitle: moderatorTitle } = moderatorResult.rows[0];

    const administratorResult = await client.query(
      `SELECT uemail FROM users WHERE usergroup = 'Administrator'`
    );

    if (administratorResult.rows.length === 0) {
      return res.status(404).json({ message: 'Administrators not found' });
    }

    const adminEmails = administratorResult.rows.map(record => record.uemail);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'laudarren911@gmail.com',
        pass: 'tlld oplc qepx hbzy',
      },
    });

    const mailOptions = {
      from: 'laudarren911@gmail.com',
      to: adminEmails,
      subject: 'Property Listing Request',
      html: `
      <h1><b>Dear Administrators,</b></h1><hr/>
      <p>Moderator ${moderatorTitle} ${moderatorLastName} would like to request listing a new property with the name of <b>${property}</b> into the "Hello Sarawak" app.</p>
      <p>Please kindly click the button below to view more details and make the decision in <b>12 hours</b> time frame.</p>
      <div style="margin: 10px 0;">
        <a href="" style="background-color: green; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-right: 10px;">Accept</a>
        <a href="" style="background-color: red; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Reject</a>
      </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Email Sent Successfully' })
  } catch (err) {
    console.error('Error sending email: ', err);
    res.status(500).json({ message: 'Failed to send email', error: err.message });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Send Property Listing Request Accepted Notification
app.post("/propertyListingAccept/:propertyid", async (req, res) => {
  const { propertyid } = req.params;
  let client;

  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT p.propertyaddress, u.ulastname, u.uemail, u.utitle 
       FROM properties p  
       JOIN users u ON u.userid = p.userid 
       WHERE p.propertyid = $1`,
      [propertyid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Property or user not found" });
    }

    const { propertyaddress: property, ulastname: moderatorLastName, uemail: moderatorEmail, utitle: moderatorTitle } = result.rows[0];

    const mailOptions = {
      from: "laudarren911@gmail.com",
      to: moderatorEmail,
      subject: "Property Listing Request Accepted",
      html: `
      <h1><b>Dear ${moderatorTitle} ${moderatorLastName},</b></h1><hr/>
      <p>Your request for property listing of property named <b>${property}</b> has been <span style="color: green">accepted</span> by the Administrator.</p>
      <p>Please kindly click the button below to check the details of the listed property.</p>
      <a href="" style="background-color: brown; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-right: 10px;">Hello Sarawak</a>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: "Email Sent Successfully" });
  } catch (err) {
    console.error("Error sending email:", err);
    res.status(500).json({ message: "Failed to send email", error: err.message });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Send Property Listing Request Rejected Notification
app.post("/propertyListingReject/:propertyid", async (req, res) => {
  const { propertyid } = req.params;
  let client;

  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT p.propertyaddress, u.ulastname, u.uemail, u.utitle 
       FROM properties p  
       JOIN users u ON u.userid = p.userid 
       WHERE p.propertyid = $1`,
      [propertyid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Property or user not found" });
    }

    const { propertyaddress: property, ulastname: moderatorLastName, uemail: moderatorEmail, utitle: moderatorTitle } = result.rows[0];

    const mailOptions = {
      from: "laudarren911@gmail.com",
      to: moderatorEmail,
      subject: "Property Listing Request Rejected",
      html: `
      <h1><b>Dear ${moderatorTitle} ${moderatorLastName},</b></h1><hr/>
      <p>Your request for property listing of property named <b>${property}</b> has been <span style="color: red">rejected</span> by the Administrator due to violation of policy.</p>
      <p>Please kindly click the button below to list the property again with appropriate information in <b>12 hours</b> time frame.</p>
      <a href="" style="background-color: brown; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-right: 10px;">Hello Sarawak</a>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: "Email Sent Successfully" });
  } catch (err) {
    console.error("Error sending email:", err);
    res.status(500).json({ message: "Failed to send email", error: err.message });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Send "Suggest" Notification To Operators
app.post('/sendSuggestNotification/:reservationid', async (req, res) => {
  const { userids } = req.body;
  const { reservationid } = req.params;

  try {
    const result = await pool.query(`
      SELECT * 
      FROM users 
      WHERE userid IN (${userids.join(', ')})
    `);

    if(result.recordset.length === 0) {
      return res.status(404).json({ message: 'No users found' });
    }

    const selectedEmails = result.recordset.map(record => record.uemail);

    const reservationResult = await pool.request()
      .input('reservationid', sql.Int, reservationid)
      .query(`SELECT p.propertyAddress, r.propertyidcheckindatetime, r.checkoutdatetime, rc.rclastname, rc.rctitle FROM Property p JOIN Reservation r ON p.propertyid = r.propertyid JOIN Reservation_Customer_Details rc ON rc.rcID = r.rcID WHERE reservationid = @reservationid`);

    if(reservationResult.recordset.length === 0) {
      return res.status(404).json({ message: 'No reservation or customer found' });
    }

    const { propertyAddress: reservationProperty, propertyidcheckindatetime: reservationCheckInDate, checkoutdatetime: reservationCheckOutDate, rclastname: customerLastName, rctitle: customerTitle } = reservationResult.recordset[0];

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'laudarren911@gmail.com',
        pass: 'tlld oplc qepx hbzy',
      },
    });

    const mailOptions = {
      from: 'laudarren911@gmail.com',
      to: selectedEmails,
      subject: 'Suggestion Available',
      html: `
      <h1><b>Dear Operators,</b></h1><hr/>
      <p>Reservation of customer <b>${customerTitle} ${customerLastName}</b> is now open for suggestion with the following details:</p>
      <p><b>Property Name:</b> ${reservationProperty}</p>
      <p><b>Check In Date:</b> ${reservationCheckInDate}</p>
      <p><b>Check Out Date:</b> ${reservationCheckOutDate}</p>
      <br/>
      <p>Please kindly click the button below to pick up the "Suggest" opportunity with first come first serve basis</p>
      <p>You may <b>ignore</b> this message if <b>not interested</b></p>
      <a href="" style="background-color: blue; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-right: 10px;">Pick Up</a>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Email Sent Successfully' })
  } catch (err) {
    console.error('Error sending email: ', err);
    res.status(500).json({ message: 'Failed to send email', error: err.message });
  }
})

//Create reservation for property
app.post('/reservation/:userid', async (req, res) => {
  const { propertyid, checkindatetime, checkoutdatetime, reservationblocktime, request, totalprice, adults, children, rcfirstname, rclastname, rcemail, rcphoneno, rctitle } = req.body;
  const userid = req.params.userid;

  if (!userid) {
    return res.status(400).json({ error: 'User ID is required' });
  }


  try {
    // Insert customer details
    const customerResult = await pool.request()
      .input('rcfirstname', sql.VarChar, rcfirstname)
      .input('rclastname', sql.VarChar, rclastname)
      .input('rcemail', sql.VarChar, rcemail)
      .input('rcphoneno', sql.BigInt, rcphoneno)
      .input('rctitle', sql.VarChar, rctitle)
      .query(`
        INSERT INTO Reservation_Customer_Details (rcfirstname, rclastname, rcemail, rcphoneno, rctitle)
        OUTPUT inserted.rcID
        VALUES (@rcfirstname, @rclastname, @rcemail, @rcphoneno, @rctitle)
      `);

    const rcID = customerResult.recordset[0].rcID;
    const reservationDateTime = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const reservationblocktime = new Date(reservationDateTime.getTime() + 60  * 1000);

    // Insert reservation details
    const reservationResult = await pool.request()
      .input('propertyid', sql.Int, propertyid)
      .input('propertyidcheckindatetime', sql.DateTime, propertyidcheckindatetime)
      .input('checkoutdatetime', sql.DateTime, checkoutdatetime)
      .input('reservationblocktime', sql.DateTime, reservationblocktime)
      .input('request', sql.VarChar, request)
      .input('totalprice', sql.Float, totalprice)
      .input('rcID', sql.Int, rcID)
      .input('reservationStatus', sql.VarChar, 'Pending')
      .input('userid', sql.Int, userid)
      .query(`
        INSERT INTO reservation (propertyid, propertyidcheckindatetime, checkoutdatetime, reservationblocktime, request, totalprice, rcID, reservationStatus, userid)
        OUTPUT inserted.reservationid
        VALUES (@propertyid, @propertyidcheckindatetime, @checkoutdatetime, @reservationblocktime, @request, @totalprice, @rcID, @reservationStatus, @userid)
      `);

    const reservationid = reservationResult.recordset[0].reservationid;

    // Log the booking in Audit_Trail with the propertyid and reservationid
    await pool.request()
      .input('timestamp', sql.DateTime, new Date())
      .input('action', sql.VarChar, `Booking created for reservationid ${reservationid} and propertyid ${propertyid}`)
      .input('userid', sql.Int, userid)
      .input('entityid', sql.Int, userid)
      .input('actiontype', sql.VarChar, `abc`)
      .input('entitytype', sql.VarChar, `abc`)
      .query(`
        INSERT INTO Audit_Trail (timestamp, action, userid, entityid, actiontype, entitytype)
        VALUES (@timestamp, @action, @userid, @entityid, @actiontype, @entitytype)
      `);

    res.status(201).json({ message: 'Reservation and Audit Log created successfully', reservationid });
  } catch (err) {
    console.error('Error inserting reservation data:', err);
    res.status(500).json({ message: 'Internal Server Error', details: err.message });
  }
});

// Fetch Book and Pay Log
app.get('/users/booklog', async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT 
        a.userid, 
        a.timestamp, 
        a.action,
        CASE 
          WHEN CHARINDEX('propertyid', a.action) > 0 
          THEN
            CAST(
              LEFT(
                LTRIM(
                  SUBSTRING(
                    a.action,
                    CHARINDEX('propertyid ', a.action) + 10, 
                    LEN(a.action) - CHARINDEX('propertyid ', a.action) + 10
                  )
                ),
                CHARINDEX(' ', 
                  LTRIM(SUBSTRING(
                    a.action,
                    CHARINDEX('propertyid ', a.action) + 10, 
                    LEN(a.action) - CHARINDEX('propertyid ', a.action) + 10
                  )) + ' ') - 1
              ) AS INT
            )
          ELSE NULL 
        END AS propertyid
      FROM Audit_Trail a
      WHERE a.action LIKE '%propertyid%'
      ORDER BY a.timestamp DESC
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error('Error fetching Book Log:', err);
    res.status(500).json({ message: 'Internal Server Error', details: err.message });
  }
});

app.get('/users/finance', async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT 
        FORMAT(propertyidcheckindatetime, 'yyyy-MM') as month,
        SUM(totalprice) AS monthlyRevenue,
        COUNT(reservationid) AS monthlyReservations
      FROM Reservation
      WHERE reservationStatus = 'Accepted'
      GROUP BY FORMAT(propertyidcheckindatetime, 'yyyy-MM')
      ORDER BY month;
    `);

    if (result.recordset && result.recordset.length > 0) {
      console.log('Monthly data:', result.recordset);
      
      res.json({
        monthlyData: result.recordset
      });
    } else {
      res.status(404).json({ message: 'No reservations found' });
    }
    
  } catch (err) {
    console.error('Error fetching finance data:', err);
    res.status(500).json({ message: 'Internal Server Error', details: err.message });
  }
});

// Fetch reservations for the logged-in user
app.get('/cart', async (req, res) => {
  const userid = req.query.userid;

  if (!userid || isNaN(userid)) {
    return res.status(400).json({ error: 'Invalid or missing userid' });
  }

  try {
    // Fetch reservations by userid from the database
    const reservationResult = await pool
      .request()
      .input('userid', sql.Int, userid)
      .query(`
        SELECT 
          r.reservationid,
          r.propertyid,
          p.propertyAddress, 
          p.propertyImage,
          r.propertyidcheckindatetime,
          r.checkoutdatetime,
          r.reservationblocktime,
          r.request,
          r.totalprice,
          r.reservationStatus,
          r.rcID,
          r.userid
        FROM 
          Reservation r
        JOIN 
          Properties p ON r.propertyid = p.propertyid
        WHERE 
          r.userid = @userid
      `);

    // Process the results to format property image if needed
    const reservations = reservationResult.recordset.map(reservation => ({
      ...reservation,
      propertyImage: reservation.propertyImage ? reservation.propertyImage.split(',') : []  // Assuming propertyImage is a comma-separated list
    }));

    res.status(200).json({ userid, reservations });
  } catch (err) {
    console.error('Error fetching reservations by userid:', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

// Fetch all reservations (Dashboard)
app.get('/reservationTable', async (req, res) => {
  const username = req.query.username;

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    // Fetch userid and usergroup from the users table
    const userResult = await pool
      .request()
      .input('username', sql.VarChar, username)
      .query(`
        SELECT userid, usergroup 
        FROM users 
        WHERE username = @username
      `);

    if (userResult.recordset.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userid = userResult.recordset[0].userid;
    const usergroup = userResult.recordset[0].usergroup;

    // Base query for fetching reservations
    let query = `
      SELECT 
        r.reservationid,
        r.propertyid,
        p.propertyAddress, 
        p.propertyImage,
        p.userid,
        r.propertyidcheckindatetime,
        r.checkoutdatetime,
        r.reservationblocktime,
        r.request,
        r.totalprice,
        r.reservationStatus,
        r.rcID,
        rc.rcfirstname,
        rc.rclastname,
        rc.rcemail,
        rc.rcphoneno,
        rc.rctitle
      FROM 
        Reservation r
      JOIN 
        Properties p ON r.propertyid = p.propertyid
      JOIN 
        Reservation_Customer_Details rc ON r.rcID = rc.rcID
    `;

    // Apply filter for moderators
    if (usergroup === 'Moderator') {
      query += ` WHERE p.userid = @userid AND r.reservationStatus IN ('Pending', 'Accepted', 'Rejected', 'Canceled', 'Paid')`;
    } else {
      query += ` WHERE r.reservationStatus IN ('Pending', 'Accepted', 'Rejected', 'Canceled', 'Paid')`;
    }

    // Execute the query
    const result = await pool
      .request()
      .input('userid', sql.Int, userid)
      .query(query);

    // Process reservations to split propertyImage into an array
    const reservations = result.recordset.map(reservation => ({
      ...reservation,
      propertyImage: reservation.propertyImage ? reservation.propertyImage.split(',') : []
    }));

    res.status(200).json({ reservations });
  } catch (err) {
    console.error('Error fetching reservation data for reservation table:', err);
    res.status(500).json({ message: 'Internal Server Error', details: err.message });
  }
});

// Update reservation status to "Canceled"
app.put('/cancelReservation/:reservationid', async (req, res) => {
  const { reservationid } = req.params;

  try {
    await pool.request()
      .input('reservationid', sql.Int, reservationid)
      .input('reservationStatus', sql.VarChar, 'Canceled')
      .query(`
        UPDATE Reservation 
        SET reservationStatus = @reservationStatus
        WHERE reservationid = @reservationid;
      `);

    res.status(200).json({ message: 'Reservation status updated to Canceled' });
  } catch (err) {
    console.error('Error updating reservation status:', err);
    res.status(500).json({ message: 'Internal Server Error', details: err.message });
  }
});

// Update reservation status
app.patch('/updateReservationStatus/:reservationid', async (req, res) => {
  const { reservationid } = req.params;
  const { reservationStatus } = req.body;

  try {
    await pool.request()
      .input('reservationStatus', sql.VarChar, reservationStatus)
      .input('reservationid', sql.Int, reservationid)
      .query(`UPDATE Reservation SET reservationStatus = @reservationStatus WHERE reservationid = @reservationid`);

    res.status(200).json({ message: 'Reservation status updated successfully' });
  } catch (error) {
    console.error('Error updating reservation status:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Remove reservation
app.delete('/removeReservation/:reservationid', async (req, res) => {
  const { reservationid } = req.params;

  try {
    // Delete reservation from the Reservation table
    await pool.request()
      .input('reservationid', sql.Int, reservationid)
      .query(`DELETE FROM Reservation WHERE reservationid = @reservationid`);

    res.status(200).json({ message: 'Reservation removed successfully' });
  } catch (err) {
    console.error('Error deleting reservation:', err);
    res.status(500).json({ message: 'Internal Server Error', details: err.message });
  }
});

// Get Properties Of Particular Administrator For "Suggest"
app.get('/operatorProperties/:userid', async (req, res) => {
  const { userid } = req.params;

  if (!userid) {
    return res.status(400).json({ message: 'userid of Operator is not found' });
  }

  try {
    const result = await pool.request()
      .input('userid', sql.Int, userid)
      .query(`SELECT * FROM Property WHERE userid = @userid AND propertyStatus = 'Available'`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: 'No properties found for this Operator' });
    }

    const propertiesWithSeparatedImages = result.recordset.map(property => ({
      ...property,
      images: property.propertyImage ? property.propertyImage.split(',') : [],
    }));

    res.status(200).json({ status: 'success', message: 'Properties Retrieved Successfully', data: propertiesWithSeparatedImages, });
  } catch (err) {
    console.error('Error retrieving properties: ', err);
    res.status(500).json({ message: 'An error occurred while retrieving properties', error: err.message });
  }
})

// Get user information
app.get('/getUserInfo/:userid', async (req, res) => {
  const { userid } = req.params;
  let client;
  console.log(userid);

  try {
    client = await pool.connect();
    
    const result = await client.query(
      `SELECT 
        "utitle",
        "ufirstname",
        "ulastname",
        "uemail",
        "uphoneno"
      FROM "users"
      WHERE "userid" = $1`,
      [userid] // 参数作为数组传递
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User information not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error getting user information:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

//Forget Password
app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  try {
    const userResult = await pool.request()
      .input('email', sql.VarChar, email)
      .query('SELECT userid, username FROM users WHERE uemail = @email');

    if (userResult.recordset.length === 0) {
      return res.status(404).json({ message: 'Email not registered' });
    }

    const { userid, username } = userResult.recordset[0];

    const newPassword = Math.random().toString(36).slice(-8);

    await pool.request()
      .input('userid', sql.Int, userid)
      .input('password', sql.VarChar, newPassword)
      .query(`
        UPDATE users 
        SET password = @password
        WHERE userid = @userid
      `);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'laudarren911@gmail.com',
        pass: 'tlld oplc qepx hbzy',
      },
    });

    const mailOptions = {
      from: 'laudarren911@gmail.com',
      to: email,
      subject: 'Hello Sarawak Password Reset',
      html: `
        <h1>Dear ${username}</h1>
        <p>You have requested a new temporary password. You may use this temporary password for your next login.</p>
        <h2 style="color: #4CAF50; font-size: 24px;">${newPassword}</h2>
        <p>Please use this password to log in and immediately change your password.</p>
        <p>If you did not request a password reset, please contact the administrator immediately.</p>
      `
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'New password has been sent to your email' });

  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Avatar 
const getDefaultAvatarBase64 = () => {
  return new Promise((resolve, reject) => {
      const defaultAvatarPath = path.join(__dirname, '/public/avatar.png'); 
      fs.readFile(defaultAvatarPath, (err, data) => {
          if (err) {
              reject(err);
          } else {
              const base64Data = data.toString('base64');
              resolve(base64Data);
          }
      });
  });
};

const generateRandomSixDigits = () => Math.floor(100000 + Math.random() * 900000);

// Get User Details
app.get('/users/:userid', async (req, res) => {
  const { userid } = req.params;

  if (isNaN(userid)) {
    return res.status(400).json({ message: "Invalid userid" });
  }

  let client;
  try {
    client = await pool.connect();
    
    const query = {
      text: "SELECT * FROM users WHERE userid = $1",
      values: [userid]
    };
    
    const result = await client.query(query);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching user data:", err);
    return res.status(500).json({ message: "Internal server error" });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Update user profile data
app.put('/users/updateProfile/:userid', async (req, res) => {
  const { userid } = req.params;
  let client;
  
  try {
    client = await pool.connect();
    
    // Get current user data to handle partial updates
    const currentUserData = await client.query('SELECT * FROM users WHERE userid = $1', [userid]);
    if (currentUserData.rows.length === 0) {
      return res.status(404).json({ message: 'User not found', success: false });
    }
    
    const current = currentUserData.rows[0];
    
    
    const {
      username = current.username,
      password = current.password, 
      ufirstname = current.ufirstname,
      ulastname = current.ulastname,
      udob = current.udob,
      utitle = current.utitle, 
      ugender = current.ugender,
      uemail = current.uemail,
      uphoneno = current.uphoneno,
      ucountry = current.ucountry,
      uzipcode = current.uzipcode
    } = req.body;
    
    // Update only the fields that are provided
    const result = await client.query(
      `UPDATE users SET 
        username = $1, 
        password = $2, 
        ufirstname = $3, 
        ulastname = $4, 
        uDOB = $5,
        utitle = $6,
        ugender = $7,
        uemail = $8, 
        uphoneno = $9, 
        ucountry = $10, 
        uzipcode = $11
      WHERE userid = $12
      RETURNING userid`,
      [username, password, ufirstname, ulastname, udob, utitle, ugender, uemail, uphoneno, ucountry, uzipcode, userid]
    );
    
    if (result.rowCount === 0) {
      return res.status(500).json({ message: 'Failed to update profile', success: false });
    }
    
    res.status(200).json({ message: 'Profile updated successfully.', success: true });
  } catch (err) {
    console.error('Error updating user profile:', err);
    res.status(500).json({ 
      message: 'An error occurred while updating the profile.', 
      details: err.message,
      success: false 
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});


// Update avatar
app.post('/users/uploadavatar/:userid', async (req, res) => {
  const { userid } = req.params;
  const { uimage } = req.body;
  let client;
  
  // Validate userid
  if (isNaN(userid)) {
    console.error("Invalid userid:", userid);
    return res.status(400).json({ message: 'Invalid userid' });
  }
  
  if (!uimage) {
    console.error("No image data received");
    return res.status(400).json({ message: 'No image data provided.' });
  }
  
  try {
    client = await pool.connect();
    
    // Check if user exists
    const userCheck = await client.query('SELECT userid FROM users WHERE userid = $1', [userid]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Store the base64 data directly
    const result = await client.query(
      `UPDATE users SET uimage = $1 WHERE userid = $2 RETURNING userid`,
      [uimage, userid]
    );
    
    if (result.rowCount === 0) {
      return res.status(500).json({ message: 'Failed to update user avatar' });
    }
    
    console.log("Avatar uploaded successfully for user:", userid);
    return res.status(200).json({ message: 'Avatar uploaded successfully' });
  } catch (err) {
    console.error("Error uploading avatar:", err);
    return res.status(500).json({ 
      message: `Error uploading avatar: ${err.message}`,
      details: err.toString()
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
