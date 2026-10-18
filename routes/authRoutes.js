const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const User = require("../models/User");
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto'); // Built-in Node.js module

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Helper function to validate email domain (Legit emails only)
function isValidEmailDomain(email) {
  if (!email || typeof email !== 'string') return false;

  const allowedDomains = [
    'gmail.com',
    'yahoo.com',
    'outlook.com',
    'hotmail.com',
    'icloud.com',
    'deped.gov.ph'
  ];

  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;

  // Allow standard trusted domains or educational domains (.edu / .edu.ph)
  const isAllowed = allowedDomains.includes(domain) || domain.endsWith('.edu.ph') || domain.endsWith('.edu');

  return isAllowed;
}

// ==================== LOGIN ====================
// GET - Render Login Page with Math Captcha (max sum = 100)
router.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === "admin" ? "/admin/dashboard" : "/customer/shop");
  }

  // Generate numbers for Math Captcha
  const num1 = Math.floor(Math.random() * 99) + 1;
  const maxNum2 = 100 - num1;
  const num2 = Math.floor(Math.random() * maxNum2) + 1;

  // Store expected answer in session
  req.session.captchaAnswer = num1 + num2;

  res.render("auth/login", { 
    title: "Login",
    captchaQuestion: `${num1} + ${num2} = ?`
  });
});

// GET - Refresh Math Captcha via AJAX
router.get("/captcha-refresh", (req, res) => {
  const num1 = Math.floor(Math.random() * 99) + 1;
  const maxNum2 = 100 - num1;
  const num2 = Math.floor(Math.random() * maxNum2) + 1;

  req.session.captchaAnswer = num1 + num2;

  res.json({
    captchaQuestion: `${num1} + ${num2} = ?`
  });
});

// POST - Authenticate User Login
router.post("/login", async (req, res) => {
  try {
    const { email, password, captchaInput } = req.body;

    // 1. Verify Math Captcha
    if (!captchaInput || parseInt(captchaInput, 10) !== req.session.captchaAnswer) {
      req.session.error = "Incorrect security check answer (Math Captcha). Please try again.";
      return res.redirect("/auth/login");
    }

    // Reset captcha answer after validation
    req.session.captchaAnswer = null;

    // 2. Fetch User and Account Status Checks
    const user = await User.findOne({ email: email.toLowerCase(), isArchived: false });

    if (!user) {
      req.session.error = "Invalid email or password.";
      return res.redirect("/auth/login");
    }

    if (user.status === "blocked") {
      req.session.denied = "Your account has been suspended. Please contact customer support for assistance.";
      return res.redirect("/auth/login");
    }

    // 3. Verify Password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      req.session.error = "Invalid email or password.";
      return res.redirect("/auth/login");
    }

    // Store user session (exclude password hash)
    const userObj = user.toObject();
    delete userObj.password;
    req.session.user = userObj;

    req.session.success = `Welcome back, ${user.firstName}!`;
    return res.redirect(user.role === "admin" ? "/admin/dashboard" : "/customer/shop");
  } catch (err) {
    console.error("❌ Login process error:", err.message);
    req.session.error = "An internal server error occurred. Please try again later.";
    return res.redirect("/auth/login");
  }
});

// ==================== REGISTER ====================
// GET - Render Registration Page
router.get("/register", (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === "admin" ? "/admin/dashboard" : "/customer/shop");
  }
  res.render("auth/register", { title: "Register" });
});

// POST - Register New Account
router.post("/register", async (req, res) => {
  try {
    const { firstName, lastName, email, phoneNumber, address, password, confirmPassword } = req.body;

    // 1. Validate Form Input Fields
    if (!firstName || !lastName || !email || !phoneNumber || !address || !password) {
      req.session.error = "Please fill out all required fields.";
      return res.redirect("/auth/register");
    }

    if (password !== confirmPassword) {
      req.session.error = "Passwords do not match. Please re-enter your password.";
      return res.redirect("/auth/register");
    }

    if (password.length < 8) {
      req.session.error = "Password must be at least 8 characters long.";
      return res.redirect("/auth/register");
    }

    // 2. Strict Email Domain Validation (Rejects temporary/disposable emails)
    if (!isValidEmailDomain(email)) {
      req.session.error = "Please use a valid email domain (e.g. @gmail.com, @deped.gov.ph, or an official institutional .edu account).";
      return res.redirect("/auth/register");
    }

    // 3. Check for Duplicate Registered Emails
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      req.session.error = "This email address is already registered. Please sign in instead.";
      return res.redirect("/auth/register");
    }

    // 4. Hash Password & Persist User Record
    const hashedPassword = await bcrypt.hash(password, 12);

    const newUser = await User.create({
      firstName,
      lastName,
      email: email.toLowerCase(),
      phoneNumber,
      address,
      password: hashedPassword,
      role: "customer",
    });

    // Auto-login session initialization
    const userObj = newUser.toObject();
    delete userObj.password;
    req.session.user = userObj;

    req.session.success = `Welcome to KDY's Arts & Crafts, ${firstName}! Your account has been successfully created.`;
    return res.redirect("/customer/shop");
  } catch (err) {
    console.error("❌ Registration process error:", err.message);
    req.session.error = "An error occurred while creating your account. Please try again.";
    return res.redirect("/auth/register");
  }
});

// ==================== LOGOUT ====================
router.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("❌ Logout session error:", err.message);
    res.redirect("/");
  });
});

// ==================== FORGOT PASSWORD ====================
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email.toLowerCase(), isArchived: false });

    if (!user) {
      // Neutral message for security purposes
      req.session.success = "If that email address is registered in our system, a temporary password has been sent to it.";
      return res.redirect("/auth/login");
    }

    // 1. Generate Secure Random Temporary Password
    const tempPassword = crypto.randomBytes(4).toString('hex'); // e.g., 'a1b2c3d4'
    
    // 2. Hash Temporary Password
    const salt = await bcrypt.genSalt(12);
    const hashedTempPassword = await bcrypt.hash(tempPassword, salt);

    // 3. Update Database Record
    user.password = hashedTempPassword;
    await user.save();

    // 4. Send Professional HTML Email via SendGrid
    const msg = {
      to: user.email,
      from: process.env.FROM_EMAIL,
      subject: 'Temporary Password Request - KDY\'s Arts & Crafts',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 550px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
          <h2 style="color: #1e293b; font-size: 20px; font-weight: 700; margin-bottom: 12px; border-bottom: 2px solid #3b82f6; padding-bottom: 8px;">
            Password Reset Request
          </h2>
          <p style="color: #475569; font-size: 14px; line-height: 1.5;">Hello <strong>${user.firstName}</strong>,</p>
          <p style="color: #475569; font-size: 14px; line-height: 1.5;">
            We received a request to reset your password for your <strong>KDY's Arts & Crafts</strong> account. Below is your temporary credentials:
          </p>
          <div style="background-color: #f1f5f9; padding: 14px; border-radius: 8px; font-size: 22px; font-weight: bold; text-align: center; letter-spacing: 3px; color: #2563eb; margin: 20px 0;">
            ${tempPassword}
          </div>
          <p style="color: #64748b; font-size: 12px; line-height: 1.4; margin-top: 16px;">
            <strong>Important Security Notice:</strong> Please sign in using this temporary password and update your password immediately under your account settings for security purposes.
          </p>
          <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
          <p style="color: #94a3b8; font-size: 11px; text-align: center;">
            If you did not request a password reset, please contact our support team immediately.
          </p>
        </div>
      `,
    };

    await sgMail.send(msg);

    req.session.success = "A temporary password has been successfully sent to your email address.";
    return res.redirect("/auth/login");

  } catch (err) {
    console.error("❌ SendGrid Email Error:", err.message);
    req.session.error = "Unable to process password reset email at this time. Please try again later.";
    return res.redirect("/auth/login");
  }
});

module.exports = router;