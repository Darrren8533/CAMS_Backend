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
        SELECT username, "uemail" FROM "users"
        WHERE username = $1 OR "uemail" = $2
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
        INSERT INTO "users" (
          username, password, "uemail", "utitle", "usergroup", "ustatus", "uactivation", "uimage",
          "ufirstname", "ulastname"
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
        userID: userid, 
        userGroup: usergroup,
        uActivation: uactivation 
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

//Google login
app.post("/google-login", async (req, res) => {
  const { token } = req.body;

  try {
      // Get user info from Google
      const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: `Bearer ${token}` }
      });
      const googleUser = await response.json();

      if (!googleUser.email) {
          return res.status(401).json({ success: false, message: "Invalid Google token" });
      }

      const { email, given_name, family_name, picture } = googleUser;
      console.log("Google User Data:", googleUser); 

      // Check if user exists
      const result = await pool.request()
         .input("email", sql.VarChar, email)
         .query("SELECT userID, userGroup, uActivation, username FROM Users WHERE uEmail = @email");

      let username;
      if (result.recordset.length > 0) {
          // Existing user, update login status
          const { userID, userGroup, uActivation, username: existingUsername } = result.recordset[0];
          username = existingUsername;

          await pool.request()
             .input("email", sql.VarChar, email)
             .query("UPDATE Users SET uStatus = 'login' WHERE uEmail = @email");

          return res.status(200).json({
              success: true,
              message: "Google Login Successful",
              userID,
              userGroup,
              uActivation,
              username
          });
      } else {

          const randomSixDigits = generateRandomSixDigits();
          username = given_name? `${given_name}_${randomSixDigits}` : `user_${randomSixDigits}`;

          // Insert new Google user
          const insertResult = await pool.request()
             .input("email", sql.VarChar, email)
             .input("uFirstName", sql.VarChar, given_name? given_name : null)
             .input("uLastName", sql.VarChar, family_name? family_name : null)
             .input("uImage", sql.VarChar, picture? picture : null)
             .input("uTitle", sql.VarChar, "Mr.")
             .input("username", sql.VarChar, username)
             .query(`
                INSERT INTO Users (uEmail, uFirstName, uLastName, uImage, uTitle, uStatus, userGroup, uActivation, username) 
                OUTPUT Inserted.userID
                VALUES (@email, @uFirstName, @uLastName, @uImage, @uTitle, 'login', 'Customer', 'Active', @username)
              `);

          const newUserID = insertResult.recordset[0].userID;

          return res.status(201).json({
              success: true,
              message: "Google Login Successful, new user created",
              userID: newUserID,
              userGroup: "Customer",
              uActivation: "Active",
              username
          });
      }
  } catch (error) {
      console.error("Google Login Error:", error);
      return res.status(500).json({ success: false, message: "Google Login Failed" });
  }
});

// 用户退出登录端点
app.post('/logout', async (req, res) => {
  const { userID } = req.body;
  let client;

  try {
    client = await pool.connect();
    
    // 更新用户状态为已登出
    const query = {
      text: "UPDATE users SET ustatus = 'logout' WHERE userid = $1",
      values: [userID]
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

// Fetch list of customers
app.get('/users/customers', async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(`
      SELECT userid, ufirstname, ulastname, uemail, uphoneno, ucountry, uzipcode, uactivation, ugender, utitle
      FROM users
      WHERE usergroup = 'Customer'
    `);
    // res.status(200).json(result.recordset);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching customers:', err);
    res.status(500).json({ message: 'Server error', success: false });
  } 
});

// Fetch list of owners
app.get('/users/owners', async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT userID, username, uFirstName, uLastName, uEmail, uPhoneNo, uCountry, uZipCode, uGender, userGroup, uTitle
      FROM Users
      WHERE userGroup = 'Owner'
    `);
    res.status(200).json(result.recordset);
  } catch (err) {
    console.error('Error fetching owners:', err);
    res.status(500).json({ message: 'Server error', success: false });
  }
});

// Fetch list of moderators
app.get('/users/moderators', async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT userID, username, uFirstName, uLastName, uEmail, uPhoneNo, userGroup, uActivation, uGender, uCountry, uZipCode, uTitle
      FROM Users
      WHERE userGroup = 'Moderator'
    `);
    res.status(200).json(result.recordset);
  } catch (err) {
    console.error('Error fetching moderators:', err);
    res.status(500).json({ message: 'Server error', success: false });
  }
});

// Fetch list of operators (Moderators and Administrators)
app.get('/users/operators', async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT userID, username, uFirstName, uLastName, uEmail, uPhoneNo, userGroup, uActivation, uGender, uCountry, uZipCode, uTitle
      FROM Users
      WHERE userGroup IN ('Moderator', 'Administrator')
    `);
    res.status(200).json(result.recordset);
  } catch (err) {
    console.error('Error fetching operators:', err);
    res.status(500).json({ message: 'Server error', success: false });
  }
});

// Fetch list of administrators
app.get('/users/administrators', async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT userID, username, uFirstName, uLastName, uEmail, uPhoneNo, userGroup, uActivation, uGender, uCountry, uZipCode
      FROM Users
      WHERE userGroup = 'Administrator'
    `);
    res.status(200).json(result.recordset);
  } catch (err) {
    console.error('Error fetching administrators:', err);
    res.status(500).json({ message: 'Server error', success: false });
  }
});

// Create moderators
app.post('/users/createModerator', async (req, res) => {
  const { firstName, lastName, username, password, email, phoneNo, country, zipCode } = req.body;

  try {
    // Check if the username or email already exists
    const checkUser = await pool.request()
      .input('username', sql.VarChar, username)
      .input('email', sql.VarChar, email)
      .query(`
        SELECT username, uEmail FROM Users
        WHERE username = @username OR uEmail = @email
      `);

    if (checkUser.recordset.length > 0) {
      return res.status(409).json({ message: 'Username or email already exists', success: false });
    }

    // Insert new user into the database
    await pool.request()
      .input('firstName', sql.VarChar, firstName)
      .input('lastName', sql.VarChar, lastName)
      .input('username', sql.VarChar, username)
      .input('password', sql.VarChar, password)  
      .input('email', sql.VarChar, email)
      .input('phoneNo', sql.BigInt, phoneNo)
      .input('country', sql.VarChar, country)
      .input('zipCode', sql.Int, zipCode)
      .input('uTitle', sql.NVarChar, 'Mr.')
      .input('userGroup', sql.VarChar, 'Moderator')  
      .input('uStatus', sql.VarChar, 'registered')
      .input('uActivation', sql.VarChar, 'Active')
      
      
      .query(`
        INSERT INTO Users (uFirstName, uLastName, username, password, uEmail, uPhoneNo, uCountry, uZipCode, uTitle, userGroup, uStatus, uActivation)
        VALUES (@firstName, @lastName, @username, @password, @email, @phoneNo, @country, @zipCode, @uTitle,  @userGroup, @uStatus, @uActivation)
      `);

    res.status(201).json({ message: 'User registered successfully', success: true });
  } catch (err) {
    console.error('Error during registration:', err);
    res.status(500).json({ message: 'Server error', success: false });
  }
});

// Update users by user ID
app.put('/users/updateUser/:userID', async (req, res) => {
  const { userID } = req.params;
  const { firstName, lastName, username, email, phoneNo, country, zipCode } = req.body;

  try {
      // Update user details 
      await pool.request()
          .input('userID', sql.Int, userID)
          .input('firstName', sql.VarChar, firstName)
          .input('lastName', sql.VarChar, lastName)
          .input('username', sql.VarChar, username)
          .input('email', sql.VarChar, email)
          .input('phoneNo', sql.BigInt, phoneNo)
          .input('country', sql.VarChar, country)
          .input('zipCode', sql.Int, zipCode)
          .query(`
              UPDATE Users
              SET uFirstName = @firstName, 
                  uLastName = @lastName, 
                  username = @username, 
                  uEmail = @email,
                  uPhoneNo = @phoneNo,
                  uCountry = @country,
                  uZipCode = @zipCode
              WHERE userID = @userID
          `);
          console.log(`
    UPDATE Users
    SET uFirstName = '${firstName}', 
        uLastName = '${lastName}', 
        username = '${username}', 
        uEmail = '${email}',
        uPhoneNo = '${phoneNo}',
        uCountry = '${country}',
        uZipCode = '${zipCode}'
    WHERE userID = '${userID}'
`);

      res.status(200).json({ message: 'User updated successfully' });
  } catch (err) {
      console.error('Error updating user:', err);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

// Remove users by user ID
app.delete('/users/removeUser/:userID', async (req, res) => {
  const { userID } = req.params;

  try {
    // Check if the user exists
    const userCheck = await pool.request()
    .input('userID', sql.Int, userID)
    .query('SELECT userID FROM Users WHERE userID = @userID');
    
    if (userCheck.recordset.length === 0) {
      return res.status(404).json({ message: 'User not found', success: false });
    }

    await pool.request()
      .input('userID', sql.Int, userID)
      .query(`
        DELETE FROM Users
        WHERE userID = @userID
      `);

    res.status(200).json({ message: 'User removed successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ message: 'Server error', success: false });
  }
});

// Suspend users by user ID
app.put('/users/suspendUser/:userID', async (req, res) => {
  try {
    const { userID } = req.params;

    await pool.request()
      .input('userID', sql.Int, userID)
      .query(`
        UPDATE Users
        SET uActivation = 'Inactive'
        WHERE userID = @userID
      `);

    res.status(200).json({ message: 'User suspended successfully' });
  } catch (err) {
    console.error('Error suspending user:', err);
    res.status(500).json({ message: 'Server error', success: false });
  }
});

// Activate users by user ID
app.put('/users/activateUser/:userID', async (req, res) => {
  try {
    const { userID } = req.params;

    await pool.request()
      .input('userID', sql.Int, userID)
      .query(`
        UPDATE Users
        SET uActivation = 'Active'
        WHERE userID = @userID
      `);

    res.status(200).json({ message: 'User activated successfully' });
  } catch (err) {
    console.error('Error activating user:', err);
    res.status(500).json({ message: 'Server error', success: false });
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

  try {
      // Fetch user ID and userGroup for property owner
      const userResult = await pool.request()
          .input('username', sql.VarChar, username)
          .query('SELECT userID, userGroup FROM Users WHERE username = @username');

      if (userResult.recordset.length === 0) {
          return res.status(404).json({ error: 'User not found' });
      }

      const { userID, userGroup } = userResult.recordset[0];

      // Determine propertyStatus based on userGroup
      const propertyStatus = userGroup === 'Administrator' ? 'Available' : 'Pending';

      // Convert images to base64 and concatenate them
      const base64Images = req.files.map(file => file.buffer.toString('base64'));
      const concatenatedImages = base64Images.join(',');

      const rateResult = await pool.request()
          .input('rateAmount', sql.Decimal(18, 2), propertyPrice)
          .input('rateType', sql.VarChar, "DefaultType") 
          .input('period', sql.VarChar, "DefaultPeriod") 
          .query(`
              INSERT INTO Rate (rateAmount, rateType, period)
              OUTPUT inserted.rateID
              VALUES (@rateAmount, @rateType, @period)
          `);

      const rateID = rateResult.recordset[0].rateID;

      const categoryResult = await pool.request()
          .input('categoryName', sql.VarChar, categoryName)
          .input('availableStates', sql.VarChar, "DefaultStates") 
          .query(`
              INSERT INTO Categories (categoryName, availableStates)
              OUTPUT inserted.categoryID
              VALUES (@categoryName, @availableStates)
          `);

      const categoryID = categoryResult.recordset[0].categoryID;

      const clusterResult = await pool.request()
          .input('clusterName', sql.VarChar, clusterName) 
          .input('clusterState', sql.VarChar, "DefaultState") 
          .input('clusterProvince', sql.VarChar, "DefaultProvince") 
          .query(`
              INSERT INTO Clusters (clusterName, clusterState, clusterProvince)
              OUTPUT inserted.clusterID
              VALUES (@clusterName, @clusterState, @clusterProvince)
          `);

      const clusterID = clusterResult.recordset[0].clusterID;
    
      // Insert new property into Properties table
      const propertyListingResult = await pool.request()
          .input('propertyNo', sql.VarChar, "1") 
          .input('userID', sql.Int, userID)
          .input('clusterID', sql.Int, clusterID) 
          .input('categoryID', sql.Int, categoryID) 
          .input('rateID', sql.Int, rateID) 
          .input('propertyAddress', sql.VarChar, propertyAddress)
          .input('propertyBedType', sql.VarChar, propertyBedType)
          .input('propertyBedImage', sql.VarChar(sql.MAX), "1")
          .input('propertyGuestPaxNo', sql.VarChar, propertyGuestPaxNo)
          .input('propertyDescription', sql.VarChar, propertyDescription)
          .input('propertyImage', sql.VarChar(sql.MAX), concatenatedImages)
          .input('propertyStatus', sql.VarChar, propertyStatus)
          .input('nearbyLocation', sql.VarChar, nearbyLocation)
          .input('facilities', sql.VarChar(sql.MAX), facilities)
          .input('policies', sql.VarChar(sql.MAX), "policies")
          .query(`
              INSERT INTO Properties (
                  propertyNo, userID, clusterID, categoryID, rateID,
                  propertyDescription, propertyAddress,
                  propertyBedType, propertyBedImage, propertyGuestPaxNo, propertyImage,
                  propertyStatus, nearbyLocation, facilities, policies
              )
              OUTPUT inserted.propertyID
              VALUES (
                  @propertyNo, @userID, @clusterID, @categoryID, @rateID,
                  @propertyDescription, @propertyAddress,
                  @propertyBedType, @propertyBedImage, @propertyGuestPaxNo, @propertyImage,
                  @propertyStatus, @nearbyLocation, @facilities, @policies
              )
          `);

      const propertyID = propertyListingResult.recordset[0].propertyID;

      res.status(201).json({ message: 'Property created successfully', propertyID });
  } catch (err) {
      console.error('Error inserting property: ', err);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

// Fetch list of all property listings (Product)
app.get('/product', async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT p.*, u.username, r.rateAmount, c.categoryName 
      FROM Properties p
      JOIN Rate r ON p.rateID = r.rateID
      JOIN Categories c ON p.categoryID = c.categoryID
      JOIN Users u ON p.userID = u.userID
      WHERE p.propertyStatus = 'Available'
    `);

    const properties = result.recordset.map(property => ({
      ...property,
      propertyImage: property.propertyImage ? property.propertyImage.split(',') : []
    }));

    res.status(200).json(properties);
  } catch (err) {
    console.error('Error fetching properties: ', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

// Fetch list of all property listings (Dashboard)
app.get('/propertiesListingTable', async (req, res) => {
  const username = req.query.username;

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    const userResult = await pool
      .request()
      .input('username', sql.VarChar, username)
      .query(`
        SELECT userID, userGroup 
        FROM Users 
        WHERE username = @username
      `);

    if (userResult.recordset.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userID = userResult.recordset[0].userID;
    const userGroup = userResult.recordset[0].userGroup;

    let query;

    if (userGroup === 'Moderator') {
      // If user is a Moderator, fetch properties created by that user only
      query = `
        SELECT 
          p.propertyID, 
          p.propertyAddress, 
          p.nearbyLocation,
          p.propertyBedType, 
          p.propertyGuestPaxNo, 
          p.propertyDescription, 
          p.propertyStatus, 
          p.propertyImage,
          u.uFirstName, 
          u.uLastName,
          u.username,
          r.rateAmount,
          cl.clusterName,
          c.categoryName
        FROM Properties p
        JOIN Users u ON p.userID = u.userID
        JOIN Rate r ON p.rateID = r.rateID
        JOIN Clusters cl ON p.clusterID = cl.clusterID
        JOIN Categories c ON p.categoryID = c.categoryID
        WHERE p.userID = @userID
      `;
    } else{
      
      query = `
        SELECT 
          p.propertyID, 
          p.propertyAddress, 
          p.nearbyLocation,
          p.propertyBedType, 
          p.propertyGuestPaxNo, 
          p.propertyDescription, 
          p.propertyStatus, 
          p.propertyImage,
          u.uFirstName, 
          u.uLastName,
          u.username,
          r.rateAmount,
          cl.clusterName,
          c.categoryName
        FROM Properties p
        JOIN Users u ON p.userID = u.userID
        JOIN Rate r ON p.rateID = r.rateID
        JOIN Clusters cl ON p.clusterID = cl.clusterID
        JOIN Categories c ON p.categoryID = c.categoryID
        WHERE p.userID = @userID
      `;
    }

    const result = await pool
      .request()
      .input('userID', sql.Int, userID)
      .query(query);

    const properties = result.recordset.map(property => ({
      ...property,
      propertyImage: property.propertyImage ? property.propertyImage.split(',') : []
    }));

    res.status(200).json({ properties });
  } catch (err) {
    console.error('Error fetching properties: ', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  } 
});

// Update an existing property listing by property ID
app.put('/propertiesListing/:propertyID', upload.array('propertyImage', 10), async (req, res) => {
  const { propertyID } = req.params;
  const {
      propertyAddress, propertyPrice, propertyDescription, nearbyLocation,
      propertyBedType, propertyGuestPaxNo, clusterName, categoryName
  } = req.body;

  const removedImages = req.body.removedImages ? JSON.parse(req.body.removedImages) : [];

  try {
      const pool = await sql.connect(dbConfig);

      // Fetch the current status of the property
      const propertyResult = await pool.request()
          .input('propertyID', sql.Int, propertyID)
          .query('SELECT propertyStatus, propertyImage FROM Properties WHERE propertyID = @propertyID');

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
          .input('propertyID', sql.Int, propertyID)
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
              WHERE propertyID = @propertyID
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

// Update property status
app.patch('/updatePropertyStatus/:propertyID', async (req, res) => {
  const { propertyID } = req.params;
  const { propertyStatus } = req.body;

  try {
    await pool.request()
      .input('propertyStatus', sql.VarChar, propertyStatus)
      .input('propertyID', sql.Int, propertyID)
      .query(`UPDATE Properties SET propertyStatus = @propertyStatus WHERE propertyID = @propertyID`);

    res.status(200).json({ message: 'Property status updated successfully' });
  } catch (error) {
    console.error('Error updating property status:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Delete a property by propertyID
app.delete('/propertiesListing/:propertyID', async (req, res) => {
  const { propertyID } = req.params;

  try {
    // Check if the property exists
    const propertyCheck = await pool.request()
      .input('propertyID', sql.Int, propertyID)
      .query('SELECT propertyID FROM Properties WHERE propertyID = @propertyID');

    if (propertyCheck.recordset.length === 0) {
      return res.status(404).json({ message: 'Property not found', success: false });
    }

    // Delete the property from the database
    await pool.request()
      .input('propertyID', sql.Int, propertyID)
      .query('DELETE FROM Properties WHERE propertyID = @propertyID');

    res.status(200).json({ message: 'Property deleted successfully', success: true });
  } catch (err) {
    console.error('Error deleting property:', err);
    res.status(500).json({ message: 'Internal Server Error', details: err.message, success: false });
  }
});

// Check user status by userID
app.get('/checkStatus', async(req, res) => {
  const { userID } = req.query;
  let client;

  try {
    client = await pool.connect();
    
    // 修改查询，获取更多用户信息
    const query = {
      text: 'SELECT userid, username, ustatus, uemail, ufirstname, ulastname FROM users WHERE userid = 2'
      
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
      console.log('User not found for ID:', userID);
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
app.post('/contact_us', async (req, res) => {
  const { name, email, message } = req.body;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'wilson336933@gmail.com',
      pass: 'nditynbfwuchdpgx',
    },
  });

  const mailOptions = {
    from: 'wilson336933@gmail.com',  
    to: 'wilson336933@gmail.com',
    subject: `Message from ${name}`,

    html: `
    <h1>New Message from ${name}</h1>
    <p><strong>Message:</strong></p>
    <p>${message}</p>
    <p><strong>Email:</strong> ${email}</p>`,

    replyTo: email, 
  };

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Email sent successfully' });
  } catch (error) {
    console.error('Error sending email:', error.response);
    res.status(500).json({ message: 'Failed to send email', error: error.response});
  }
});

// Send Booking Request Message To Administrator Or Moderator
app.post('/requestBooking/:reservationID', async (req, res) => {
  const { reservationID } = req.params;

  try {
    const result = await pool.request()
      .input('reservationID', sql.Int, reservationID)
      .query(`SELECT rc.rcLastName, rc.rcTitle, r.checkInDateTime, r.checkOutDateTime, r.request, r.totalPrice, p.propertyAddress, u.uEmail FROM Reservation_Customer_Details rc JOIN Reservation r ON rc.rcID = r.rcID JOIN Properties p ON r.propertyID = p.propertyID JOIN Users u ON u.userID = p.userID WHERE reservationID = @reservationID`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: 'Reservation or user not found for this property' });
    }

    const { rcLastName: customerLastName, rcTitle: customerTitle, checkInDateTime: reservationCheckInDateTime, checkOutDateTime: reservationCheckOutDateTime, request: reservationRequest = '-', totalPrice: reservationTotalPrice, propertyAddress: reservationProperty, uEmail: userEmail } = result.recordset[0];

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
      <p><b>Check In Date:</b> ${reservationCheckInDateTime}</p>
      <p><b>Check Out Date:</b> ${reservationCheckOutDateTime}</p>
      <p><b>Pax Number:</b> ${reservationPaxNumber}</p>
      <p><b>Request:</b> ${reservationRequest}</p>
      <p><b>Property Name:</b> ${reservationProperty}</p>
      <p><b>Total Price: <i>RM${reservationTotalPrice}</i></b></p><br/>
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
app.post('/accept_booking/:reservationID', async (req, res) => {
  const { reservationID } = req.params;

  try {
    const result = await pool.request()
      .input('reservationID', sql.Int, reservationID)
      .query(`SELECT rc.rcLastName, rc.rcEmail, rc.rcTitle, r.checkInDateTime, r.checkOutDateTime, r.reservationBlockTime, p.propertyAddress FROM Reservation_Customer_Details rc JOIN Reservation r ON rc.rcID = r.rcID JOIN Properties p ON r.propertyID = p.propertyID WHERE reservationID = @reservationID`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: 'Reservation customer or property not found for this reservation' });
    }

    const { rcLastName: customerLastName, rcEmail: customerEmail, rcTitle: customerTitle, checkInDateTime: reservationCheckInDate, checkOutDateTime: reservationCheckOutDate, reservationBlockTime: paymentDueDate, propertyAddress: reservationProperty } = result.recordset[0];

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
app.post('/suggestNewRoom/:propertyID/:reservationID', async (req, res) => {
  const { propertyID, reservationID } = req.params;

  try {
    const result = await pool.request()
      .input('propertyID', sql.Int, propertyID)
      .query(`SELECT propertyAddress, propertyPrice, propertyLocation, propertyBedType, propertyGuestPaxNo FROM Property WHERE propertyID = @propertyID`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: 'Property not found for suggestion' });
    }

    const property = result.recordset[0];

    const { propertyAddress: suggestpropertyAddress, propertyPrice: suggestPropertyPrice, propertyLocation: suggestPropertyLocation, propertyBedType: suggestPropertyBedType, propertyGuestPaxNo: suggestPropertyGuestPaxNo } = property;

    const customerReservationResult = await pool.request()
      .input('reservationID', sql.Int, reservationID)
      .query(`SELECT rc.rcLastName, rc.rcEmail, rc.rcTitle, p.propertyAddress, r.checkInDateTime, r.checkOutDateTime FROM Reservation r JOIN Properties p ON p.propertyID = r.propertyID JOIN Reservation_Customer_Details rc ON rc.rcID = r.rcID WHERE reservationID = @reservationID`);

    if (customerReservationResult.recordset.length === 0) {
      return res.status(404).json({ message: 'User email not found for suggestion' });
    }

    const { rcLastName: customerLastName, rcEmail: customerEmail, rcTitle: customerTitle, propertyAddress: reservationProperty, checkInDateTime: reservationCheckInDate, checkOutDateTime: reservationCheckOutDate } = customerReservationResult.recordset[0];

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
app.post('/propertyListingRequest/:propertyID', async (req, res) => {
  const { propertyID } = req.params;

  try {
    const moderatorResult = await pool.request()
      .input('propertyID', sql.Int, propertyID)
      .query(`SELECT p.propertyAddress, u.uLastName, u.uTitle, u.userGroup FROM Property p JOIN Users u ON u.userID = p.userID WHERE p.propertyID = @propertyID`);

    if (moderatorResult.recordset.length === 0) {
      return res.status(404).json({ message: 'Property or moderator not found for this property listing request' });
    } else if (moderatorResult.recordset[0].userGroup !== 'Moderator') {
      return res.status(200).json({ message: 'Property Created Successfully' });
    }

    const { propertyAddress: property, uLastName: moderatorLastName, uTitle: moderatorTitle } = moderatorResult.recordset[0];

    const administratorResult = await pool.request()
      .query(`SELECT uEmail FROM Users WHERE userGroup = 'Administrator'`)

    if (administratorResult.recordset.length === 0) {
      return res.status(404).json({ message: 'Administrators not found' });
    }

    const adminEmails = administratorResult.recordset.map(record => record.uEmail);

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
  }
});

// Send Properties Listing Request Accepted Notification To Moderator
app.post('/propertyListingAccept/:propertyID', async (req, res) => {
  const { propertyID } = req.params;

  try {
    const result = await pool.request()
      .input('propertyID', sql.Int, propertyID)
      .query(`SELECT p.propertyAddress, u.uLastName, u.uEmail, u.uTitle FROM Property p JOIN Users u ON u.userID = p.userID WHERE p.propertyID = @propertyID`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: 'Property or user not found for this reservation' });
    }

    const { propertyAddress: property, uLastName: moderatorLastName, uEmail: moderatorEmail, uTitle: moderatorTitle } = result.recordset[0];

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'laudarren911@gmail.com',
        pass: 'tlld oplc qepx hbzy',
      },
    });

    const mailOptions = {
      from: 'laudarren911@gmail.com',
      to: moderatorEmail,
      subject: 'Property Listing Request Accepted',
      html: `
      <h1><b>Dear ${moderatorTitle} ${moderatorLastName},</b></h1><hr/>
      <p>Your request for property listing of property named <b>${property}</b> has been <span style="color: green">accepted</span> by the Administrator.</p>
      <p>Please kindly click the button below to check the details of the listed property.</p>
      <a href="" style="background-color: brown; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-right: 10px;">Hello Sarawak</a>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Email Sent Successfully' })
  } catch (err) {
    console.error('Error sending email: ', err);
    res.status(500).json({ message: 'Failed to send email', error: err.message });
  }
});

// Send Properties Listing Request Rejected Notification To Moderator
app.post('/propertyListingReject/:propertyID', async (req, res) => {
  const { propertyID } = req.params;

  try {
    const result = await pool.request()
      .input('propertyID', sql.Int, propertyID)
      .query(`SELECT p.propertyAddress, u.uLastName, u.uEmail, u.uTitle FROM Property p JOIN Users u ON u.userID = p.userID WHERE p.propertyID = @propertyID`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: 'Property or user not found for this reservation' });
    }

    const { propertyAddress: property, uLastName: moderatorLastName, uEmail: moderatorEmail, uTitle: moderatorTitle } = result.recordset[0];

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'laudarren911@gmail.com',
        pass: 'tlld oplc qepx hbzy',
      },
    });

    const mailOptions = {
      from: 'laudarren911@gmail.com',
      to: moderatorEmail,
      subject: 'Property Listing Request Rejected',
      html: `
      <h1><b>Dear ${moderatorTitle} ${moderatorLastName},</b></h1><hr/>
      <p>Your request for property listing of property named <b>${property}</b> has been <span style="color: red">rejected</span> by the Administrator due to violation of policy.</p>
      <p>Please kindly click the button below to list the property again with appropriate information in <b>12 hours</b> time frame.</p>
      <a href="" style="background-color: brown; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-right: 10px;">Hello Sarawak</a>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Email Sent Successfully' })
  } catch (err) {
    console.error('Error sending email: ', err);
    res.status(500).json({ message: 'Failed to send email', error: err.message });
  }
});

// Send "Suggest" Notification To Operators
app.post('/sendSuggestNotification/:reservationID', async (req, res) => {
  const { userIDs } = req.body;
  const { reservationID } = req.params;

  try {
    const result = await pool.query(`
      SELECT * 
      FROM Users 
      WHERE userID IN (${userIDs.join(', ')})
    `);

    if(result.recordset.length === 0) {
      return res.status(404).json({ message: 'No users found' });
    }

    const selectedEmails = result.recordset.map(record => record.uEmail);

    const reservationResult = await pool.request()
      .input('reservationID', sql.Int, reservationID)
      .query(`SELECT p.propertyAddress, r.checkInDateTime, r.checkOutDateTime, rc.rcLastName, rc.rcTitle FROM Property p JOIN Reservation r ON p.propertyID = r.propertyID JOIN Reservation_Customer_Details rc ON rc.rcID = r.rcID WHERE reservationID = @reservationID`);

    if(reservationResult.recordset.length === 0) {
      return res.status(404).json({ message: 'No reservation or customer found' });
    }

    const { propertyAddress: reservationProperty, checkInDateTime: reservationCheckInDate, checkOutDateTime: reservationCheckOutDate, rcLastName: customerLastName, rcTitle: customerTitle } = reservationResult.recordset[0];

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
app.post('/reservation/:userID', async (req, res) => {
  const { propertyID, checkInDateTime, checkOutDateTime, reservationBlockTime, request, totalPrice, adults, children, rcFirstName, rcLastName, rcEmail, rcPhoneNo, rcTitle } = req.body;
  const userID = req.params.userID;

  if (!userID) {
    return res.status(400).json({ error: 'User ID is required' });
  }


  try {
    // Insert customer details
    const customerResult = await pool.request()
      .input('rcFirstName', sql.VarChar, rcFirstName)
      .input('rcLastName', sql.VarChar, rcLastName)
      .input('rcEmail', sql.VarChar, rcEmail)
      .input('rcPhoneNo', sql.BigInt, rcPhoneNo)
      .input('rcTitle', sql.VarChar, rcTitle)
      .query(`
        INSERT INTO Reservation_Customer_Details (rcFirstName, rcLastName, rcEmail, rcPhoneNo, rcTitle)
        OUTPUT inserted.rcID
        VALUES (@rcFirstName, @rcLastName, @rcEmail, @rcPhoneNo, @rcTitle)
      `);

    const rcID = customerResult.recordset[0].rcID;
    const reservationDateTime = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const reservationBlockTime = new Date(reservationDateTime.getTime() + 60  * 1000);

    // Insert reservation details
    const reservationResult = await pool.request()
      .input('propertyID', sql.Int, propertyID)
      .input('checkInDateTime', sql.DateTime, checkInDateTime)
      .input('checkOutDateTime', sql.DateTime, checkOutDateTime)
      .input('reservationBlockTime', sql.DateTime, reservationBlockTime)
      .input('request', sql.VarChar, request)
      .input('totalPrice', sql.Float, totalPrice)
      .input('rcID', sql.Int, rcID)
      .input('reservationStatus', sql.VarChar, 'Pending')
      .input('userID', sql.Int, userID)
      .query(`
        INSERT INTO Reservation (propertyID, checkInDateTime, checkOutDateTime, reservationBlockTime, request, totalPrice, rcID, reservationStatus, userID)
        OUTPUT inserted.reservationID
        VALUES (@propertyID, @checkInDateTime, @checkOutDateTime, @reservationBlockTime, @request, @totalPrice, @rcID, @reservationStatus, @userID)
      `);

    const reservationID = reservationResult.recordset[0].reservationID;

    // Log the booking in Audit_Trail with the propertyID and reservationID
    await pool.request()
      .input('timestamp', sql.DateTime, new Date())
      .input('action', sql.VarChar, `Booking created for reservationID ${reservationID} and propertyID ${propertyID}`)
      .input('userID', sql.Int, userID)
      .input('entityID', sql.Int, userID)
      .input('actionType', sql.VarChar, `abc`)
      .input('entityType', sql.VarChar, `abc`)
      .query(`
        INSERT INTO Audit_Trail (timestamp, action, userID, entityID, actionType, entityType)
        VALUES (@timestamp, @action, @userID, @entityID, @actionType, @entityType)
      `);

    res.status(201).json({ message: 'Reservation and Audit Log created successfully', reservationID });
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
        a.userID, 
        a.timestamp, 
        a.action,
        CASE 
          WHEN CHARINDEX('PropertyID', a.action) > 0 
          THEN
            CAST(
              LEFT(
                LTRIM(
                  SUBSTRING(
                    a.action,
                    CHARINDEX('PropertyID ', a.action) + 10, 
                    LEN(a.action) - CHARINDEX('PropertyID ', a.action) + 10
                  )
                ),
                CHARINDEX(' ', 
                  LTRIM(SUBSTRING(
                    a.action,
                    CHARINDEX('PropertyID ', a.action) + 10, 
                    LEN(a.action) - CHARINDEX('PropertyID ', a.action) + 10
                  )) + ' ') - 1
              ) AS INT
            )
          ELSE NULL 
        END AS propertyID
      FROM Audit_Trail a
      WHERE a.action LIKE '%PropertyID%'
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
        FORMAT(checkInDateTime, 'yyyy-MM') as month,
        SUM(totalPrice) AS monthlyRevenue,
        COUNT(reservationID) AS monthlyReservations
      FROM Reservation
      WHERE reservationStatus = 'Accepted'
      GROUP BY FORMAT(checkInDateTime, 'yyyy-MM')
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
  const userID = req.query.userID;

  if (!userID || isNaN(userID)) {
    return res.status(400).json({ error: 'Invalid or missing userID' });
  }

  try {
    // Fetch reservations by userID from the database
    const reservationResult = await pool
      .request()
      .input('userID', sql.Int, userID)
      .query(`
        SELECT 
          r.reservationID,
          r.propertyID,
          p.propertyAddress, 
          p.propertyImage,
          r.checkInDateTime,
          r.checkOutDateTime,
          r.reservationBlockTime,
          r.request,
          r.totalPrice,
          r.reservationStatus,
          r.rcID,
          r.userID
        FROM 
          Reservation r
        JOIN 
          Properties p ON r.propertyID = p.propertyID
        WHERE 
          r.userID = @userID
      `);

    // Process the results to format property image if needed
    const reservations = reservationResult.recordset.map(reservation => ({
      ...reservation,
      propertyImage: reservation.propertyImage ? reservation.propertyImage.split(',') : []  // Assuming propertyImage is a comma-separated list
    }));

    res.status(200).json({ userID, reservations });
  } catch (err) {
    console.error('Error fetching reservations by userID:', err);
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
    // Fetch userID and userGroup from the Users table
    const userResult = await pool
      .request()
      .input('username', sql.VarChar, username)
      .query(`
        SELECT userID, userGroup 
        FROM Users 
        WHERE username = @username
      `);

    if (userResult.recordset.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userID = userResult.recordset[0].userID;
    const userGroup = userResult.recordset[0].userGroup;

    // Base query for fetching reservations
    let query = `
      SELECT 
        r.reservationID,
        r.propertyID,
        p.propertyAddress, 
        p.propertyImage,
        p.userID,
        r.checkInDateTime,
        r.checkOutDateTime,
        r.reservationBlockTime,
        r.request,
        r.totalPrice,
        r.reservationStatus,
        r.rcID,
        rc.rcFirstName,
        rc.rcLastName,
        rc.rcEmail,
        rc.rcPhoneNo,
        rc.rcTitle
      FROM 
        Reservation r
      JOIN 
        Properties p ON r.propertyID = p.propertyID
      JOIN 
        Reservation_Customer_Details rc ON r.rcID = rc.rcID
    `;

    // Apply filter for moderators
    if (userGroup === 'Moderator') {
      query += ` WHERE p.userID = @userID AND r.reservationStatus IN ('Pending', 'Accepted', 'Rejected', 'Canceled', 'Paid')`;
    } else {
      query += ` WHERE r.reservationStatus IN ('Pending', 'Accepted', 'Rejected', 'Canceled', 'Paid')`;
    }

    // Execute the query
    const result = await pool
      .request()
      .input('userID', sql.Int, userID)
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
app.put('/cancelReservation/:reservationID', async (req, res) => {
  const { reservationID } = req.params;

  try {
    await pool.request()
      .input('reservationID', sql.Int, reservationID)
      .input('reservationStatus', sql.VarChar, 'Canceled')
      .query(`
        UPDATE Reservation 
        SET reservationStatus = @reservationStatus
        WHERE reservationID = @reservationID;
      `);

    res.status(200).json({ message: 'Reservation status updated to Canceled' });
  } catch (err) {
    console.error('Error updating reservation status:', err);
    res.status(500).json({ message: 'Internal Server Error', details: err.message });
  }
});

// Update reservation status
app.patch('/updateReservationStatus/:reservationID', async (req, res) => {
  const { reservationID } = req.params;
  const { reservationStatus } = req.body;

  try {
    await pool.request()
      .input('reservationStatus', sql.VarChar, reservationStatus)
      .input('reservationID', sql.Int, reservationID)
      .query(`UPDATE Reservation SET reservationStatus = @reservationStatus WHERE reservationID = @reservationID`);

    res.status(200).json({ message: 'Reservation status updated successfully' });
  } catch (error) {
    console.error('Error updating reservation status:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Remove reservation
app.delete('/removeReservation/:reservationID', async (req, res) => {
  const { reservationID } = req.params;

  try {
    // Delete reservation from the Reservation table
    await pool.request()
      .input('reservationID', sql.Int, reservationID)
      .query(`DELETE FROM Reservation WHERE reservationID = @reservationID`);

    res.status(200).json({ message: 'Reservation removed successfully' });
  } catch (err) {
    console.error('Error deleting reservation:', err);
    res.status(500).json({ message: 'Internal Server Error', details: err.message });
  }
});

// Get Properties Of Particular Administrator For "Suggest"
app.get('/operatorProperties/:userID', async (req, res) => {
  const { userID } = req.params;

  if (!userID) {
    return res.status(400).json({ message: 'userID of Operator is not found' });
  }

  try {
    const result = await pool.request()
      .input('userID', sql.Int, userID)
      .query(`SELECT * FROM Property WHERE userID = @userID AND propertyStatus = 'Available'`);

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
app.get('/getUserInfo/:userID', async (req, res) => {
  const { userID } = req.params;

  try {
    const result = await pool.request()
      .input('userID', sql.Int, userID)
      .query(`
        SELECT 
          uTitle,
          uFirstName,
          uLastName,
          uEmail,
          uPhoneNo
        FROM Users
        WHERE userID = @userID
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: 'User information not found' });
    }

    res.json(result.recordset[0]);
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
      .query('SELECT userID, username FROM Users WHERE uEmail = @email');

    if (userResult.recordset.length === 0) {
      return res.status(404).json({ message: 'Email not registered' });
    }

    const { userID, username } = userResult.recordset[0];

    const newPassword = Math.random().toString(36).slice(-8);

    await pool.request()
      .input('userID', sql.Int, userID)
      .input('password', sql.VarChar, newPassword)
      .query(`
        UPDATE Users 
        SET password = @password
        WHERE userID = @userID
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
app.get("/users/:userID", async (req, res) => {
  const { userID } = req.params;

  if (isNaN(userID)) {
    return res.status(400).json({ message: "Invalid userID" });
  }

  try {
    const result = await pool.request()
      .input("userID", sql.Int, userID)
      .query("SELECT * FROM Users WHERE userID = @userID");

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json(result.recordset[0]);
  } catch (err) {
    console.error("Error fetching user data:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Update Profile
app.put('/users/updateProfile/:userID', async (req, res) => {
const { userID } = req.params;

// Skip validation and assume all fields are provided correctly
const { username, password, uFirstName, uLastName, uDOB, uTitle,  uGender,  uEmail, uPhoneNo, uCountry, uZipCode } = req.body;

try {
  await pool.request()
    .input('userID', sql.Int, userID)
    .input('username', sql.VarChar, username)
    .input('password', sql.VarChar, password)
    .input('uFirstName', sql.VarChar, uFirstName)
    .input('uLastName', sql.VarChar, uLastName)
    .input('uDOB', sql.DateTime, uDOB)
    .input('uTitle', sql.NVarChar, uTitle)
    .input('uGender', sql.VarChar, uGender)
    .input('uEmail', sql.VarChar, uEmail)
    .input('uPhoneNo', sql.VarChar, uPhoneNo)
    .input('uCountry', sql.VarChar, uCountry)
    .input('uZipCode', sql.Int, uZipCode) 
    .query(`
      UPDATE Users SET 
        username = @username, 
        password = @password, 
        uFirstName = @uFirstName, 
        uLastName = @uLastName, 
        uDOB = @uDOB,
        uTitle = @uTitle,
        uGender = @uGender,
        uEmail = @uEmail, 
        uPhoneNo = @uPhoneNo, 
        uCountry = @uCountry, 
        uZipCode = @uZipCode
      WHERE userID = @userID
    `);

  res.status(200).json({ message: 'Profile updated successfully.', success: true });
} catch (err) {
  console.error('Error updating owner profile:', err);
  res.status(500).json({ message: 'An error occurred while updating the profile.', success: false });
}
});

//Upload Avatar
app.post('/users/uploadAvatar/:userID', async (req, res) => {
  const { userID } = req.params;
  const { uImage } = req.body; 

  // Validate userID
  if (isNaN(userID)) {
      console.error("Invalid userID:", userID);
      return res.status(400).json({ message: 'Invalid userID' });
  }


  if (!uImage) {
      console.error("No image data received");
      return res.status(400).json({ message: 'No image data provided.' });
  }

  try {

      await pool.request()
          .input('userID', sql.Int, userID)
          .input('uImage', sql.VarChar(sql.MAX), uImage) 
          .query(`UPDATE Users SET uImage = @uImage WHERE userID = @userID`);

      console.log("Avatar uploaded successfully!");
      return res.status(200).json({ message: 'Avatar uploaded successfully' });
  } catch (err) {
      console.error("Error uploading avatar:", err);
      return res.status(500).json({ message: 'Internal server error while uploading avatar.' });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});