require('dotenv').config();
const express = require('express');
const path = require('path');
const morgan = require('morgan');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);
const engine = require('ejs-mate');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const flash = require('connect-flash');
const helmet = require('helmet');

// ==================== ROUTE IMPORTS ====================
const authRoutes = require('./routes/authRoutes');
const customerRoutes = require('./routes/customerRoutes');
const adminRoutes = require('./routes/adminRoutes');

const app = express();
const PORT = process.env.PORT || 1000;
process.env.TZ = "Asia/Manila";

// ==================== DATABASE ====================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ order26 DB Access Granted'))
  .catch(err => console.error('❌ order26 DB Access Denied, Why? :', err));

// ==================== SESSION STORE ====================
const store = new MongoDBStore({
  uri: process.env.MONGO_URI,
  collection: 'sessions'
});

store.on('error', (error) => {
  console.error('Session store error:', error);
});

// ==================== VIEW ENGINE ====================
app.engine('ejs', engine);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ==================== CORE MIDDLEWARE ====================
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '0',
  etag: true
}));

// ==================== SESSION ====================
app.use(session({
  secret: process.env.SESSION_SECRET || 'ferry2025',
  resave: false,
  saveUninitialized: false,
  store: store,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 // 1 day
  }
}));

// ==================== FLASH MESSAGES ====================
app.use(flash());

// ==================== HELMET (CSP) ====================
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "'unsafe-eval'",
        "https://cdn.tailwindcss.com",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
        "https://kit.fontawesome.com",
        "https://ka-f.fontawesome.com",
        "https://cdn.sheetjs.com",
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
        "https://ka-f.fontawesome.com",
        "https://cdn.tailwindcss.com",
      ],
      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com",
        "https://fonts.googleapis.com",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
        "https://ka-f.fontawesome.com",
      ],
      imgSrc: [
        "'self'",
        "data:",
        "https://res.cloudinary.com",
      ],
      connectSrc: [
        "'self'",
        "https://ka-f.fontawesome.com",
        "https://cdn.jsdelivr.net",
        "https://cdn.tailwindcss.com",
      ],
      objectSrc: ["'none'"],
      frameSrc: ["'self'"],
    }
  })
);

// ==================== CACHE CONTROL ====================
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ==================== GLOBAL VARIABLES (res.locals) ====================
app.use((req, res, next) => {
  // Flash messages from connect-flash
  res.locals.messageSuccess = req.flash('messageSuccess');
  res.locals.messagePass = req.flash('messagePass');

  // Session-based flash messages
  res.locals.back = '';
  res.locals.active = '';
  res.locals.error = req.session.error || null;
  res.locals.message = req.session.message || null;
  res.locals.warning = req.session.warning || null;
  res.locals.success = req.session.success || null;
  res.locals.denied = req.session.denied || null;

  // User data
  res.locals.user = req.session.user || null;

  // Clear session messages after reading (flash-like behavior)
  req.session.error = null;
  req.session.message = null;
  req.session.warning = null;
  req.session.success = null;
  req.session.denied = null;

  next();
});

// ==================== CLOUDINARY ====================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const cloudStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: 'order26',
    resource_type: 'auto',
    public_id: `${Date.now()}-${file.originalname}`
  })
});

const upload = multer({
  storage: cloudStorage,
  limits: { fileSize: 524288000 }, // 500MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed!"));
    }
    cb(null, true);
  }
});

// Apply multer globally (upload.any() handles all file fields)
const cpUpload = upload.any();
app.use((req, res, next) => {
  cpUpload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        req.session.error = 'File must not exceed 500MB!';
        return res.redirect('back');
      }
      req.session.error = `Upload error: ${err.message}`;
      return res.redirect('back');
    } else if (err) {
      req.session.error = err.message || 'Upload failed.';
      return res.redirect('back');
    }
    next();
  });
});

// ==================== ROUTES ====================
// Auth routes (login, register, logout)
app.use('/auth', authRoutes);

// Customer routes (shop, cart, checkout, orders, notifications, profile)
app.use('/customer', customerRoutes);

// Admin routes (dashboard, orders, products, customers, profile)
app.use('/admin', adminRoutes);

// Landing page
app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'admin' ? '/admin/dashboard' : '/customer/shop');
  }
  res.render('index', { title: 'Welcome' });
});

// Home page
app.get('/h', (req, res) => {
  res.render('home', { title: 'Home' });
});

// ==================== ERROR HANDLING ====================
// 404 - Page not found
app.use((req, res) => {
  res.status(404);
  res.locals.error = 'Oops! Page cannot be found!';
  console.log(`404 triggered: ${req.originalUrl}`);
  res.render('index', { title: 'Page Not Found' });
});

// 500 - Server error
app.use((err, req, res, next) => {
  console.error('⚠️ Error occurred:', err.message);
  res.locals.error = 'Oh no! Something went wrong!';
  res.status(500).render('index', {
    title: 'Server Error',
    message: `Something went wrong: ${err.message}`,
    error: 'Oh no! Something went wrong!'
  });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`🚀 KDY's Arts & Crafts running at http://localhost:${PORT}`);
});
