const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const User = require("../models/User");
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto'); // Built-in sa Node.js
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ==================== LOGIN ====================
// GET - Show login page
router.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === "admin" ? "/admin/dashboard" : "/customer/shop");
  }
  res.render("auth/login", { title: "Login" });
});

// POST - Process login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: email.toLowerCase(), isArchived: false });

    if (!user) {
      req.session.error = "Invalid email or password.";
      return res.redirect("/auth/login");
    }

    if (user.status === "blocked") {
      req.session.denied = "Your account has been blocked. Please contact support.";
      return res.redirect("/auth/login");
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      req.session.error = "Invalid email or password.";
      return res.redirect("/auth/login");
    }

    // Store user in session (exclude password)
    const userObj = user.toObject();
    delete userObj.password;
    req.session.user = userObj;

    req.session.success = `Welcome back, ${user.firstName}!`;
    return res.redirect(user.role === "admin" ? "/admin/dashboard" : "/customer/shop");
  } catch (err) {
    console.error("❌ Login error:", err.message);
    req.session.error = "Something went wrong. Please try again.";
    return res.redirect("/auth/login");
  }
});

// ==================== REGISTER ====================
// GET - Show register page
router.get("/register", (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === "admin" ? "/admin/dashboard" : "/customer/shop");
  }
  res.render("auth/register", { title: "Register" });
});

// POST - Process registration
router.post("/register", async (req, res) => {
  try {
    const { firstName, lastName, email, phoneNumber, address, password, confirmPassword } = req.body;

    // Validation
    if (!firstName || !lastName || !email || !phoneNumber || !address || !password) {
      req.session.error = "All fields are required.";
      return res.redirect("/auth/register");
    }

    if (password !== confirmPassword) {
      req.session.error = "Passwords do not match.";
      return res.redirect("/auth/register");
    }

    if (password.length < 8) {
      req.session.error = "Password must be at least 8 characters.";
      return res.redirect("/auth/register");
    }

    // Check if email already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      req.session.error = "Email is already registered.";
      return res.redirect("/auth/register");
    }

    // Hash password & create user
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

    // Auto-login after registration
    const userObj = newUser.toObject();
    delete userObj.password;
    req.session.user = userObj;

    req.session.success = `Welcome to KDY's Arts & Crafts, ${firstName}!`;
    return res.redirect("/customer/shop");
  } catch (err) {
    console.error("❌ Registration error:", err.message);
    req.session.error = "Something went wrong during registration.";
    return res.redirect("/auth/register");
  }
});

// ==================== LOGOUT ====================
router.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("❌ Logout error:", err.message);
    res.redirect("/");
  });
});

router.post("/forgot-password", async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email: email.toLowerCase(), isArchived: false });

        if (!user) {
            // Para sa security, huwag sabihin kung ang email ay wala sa DB. 
            // Sabihin na lang na "Check your email".
            req.session.success = "If that email exists in our system, a temporary password has been sent.";
            return res.redirect("/auth/login");
        }

        // 1. Generate random temporary password
        const tempPassword = crypto.randomBytes(4).toString('hex'); // Halimbawa: 'a1b2c3d4'
        
        // 2. Hash the temporary password
        const salt = await bcrypt.genSalt(12);
        const hashedTempPassword = await bcrypt.hash(tempPassword, salt);

        // 3. Update User in Database
        user.password = hashedTempPassword;
        await user.save();

        // 4. Send Email via SendGrid
        const msg = {
            to: user.email,
            from: process.env.FROM_EMAIL, // Dapat verified ito sa SendGrid
            subject: 'Temporary Password - KDY\'s Arts & Crafts',
            html: `
                <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                    <h2 style="color: #333;">Password Reset Request</h2>
                    <p>Hello ${user.firstName},</p>
                    <p>Natanggap namin ang iyong request para sa password reset. Narito ang iyong temporary password:</p>
                    <div style="background: #f4f4f4; padding: 10px; font-size: 20px; font-weight: bold; text-align: center; letter-spacing: 2px;">
                        ${tempPassword}
                    </div>
                    <p style="color: #666; font-size: 12px; margin-top: 20px;">
                        Paalala: Pakipalitan agad ang password na ito pagkalogin para sa iyong seguridad.
                    </p>
                </div>
            `,
        };

        await sgMail.send(msg);

        req.session.success = "A temporary password has been sent to your email.";
        return res.redirect("/auth/login");

    } catch (err) {
        console.error("❌ SendGrid Error:", err.message);
        req.session.error = "Failed to send email. Please try again later.";
        return res.redirect("/auth/login");
    }
});

module.exports = router;
