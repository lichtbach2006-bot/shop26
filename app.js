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
const rateLimit = require('express-rate-limit');
const { doubleCsrf } = require("csrf-csrf");

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
  .catch(err => console.error('❌ order26 DB Access Denied, Why?:', err));

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

// ==================== RATE LIMITING (Security) ====================
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 15 minutes."
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many login attempts from this IP, please try again later."
});
app.use('/auth/login', authLimiter);

// ==================== SESSION ====================
app.use(session({
  secret: process.env.SESSION_SECRET || 'ferry2025',
  resave: false,
  saveUninitialized: false,
  store: store,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24
  }
}));

// ==================== CSRF PROTECTION ====================
const { doubleCsrfProtection, generateToken } = doubleCsrf({
  getSecret: () => process.env.SESSION_SECRET || 'ferry2025',
  cookieName: "__Host-psrf.x-token",
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/"
  },
  getTokenFromRequest: (req) => {
    return req.body._csrf || req.headers["x-csrf-token"];
  }
});

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
      scriptSrcAttr: ["'unsafe-inline'"], 
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
        "blob:",
        "https://res.cloudinary.com",
        "https://*.openstreetmap.org",
        "https://cdnjs.cloudflare.com",
      ],
      connectSrc: [
        "'self'",
        "https://ka-f.fontawesome.com",
        "https://cdn.jsdelivr.net",
        "https://cdn.tailwindcss.com",
        "https://res.cloudinary.com",
        "https://*.openstreetmap.org",
        "https://nominatim.openstreetmap.org",
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

// ==================== GLOBAL VARIABLES & CSRF TOKEN (res.locals) ====================
app.use((req, res, next) => {
  try {
    res.locals.csrfToken = generateToken(req, res);
  } catch (e) {
    res.locals.csrfToken = "";
  }

  res.locals.messageSuccess = req.flash('messageSuccess');
  res.locals.messagePass = req.flash('messagePass');

  res.locals.back = '';
  res.locals.active = '';
  res.locals.error = req.session.error || null;
  res.locals.message = req.session.message || null;
  res.locals.warning = req.session.warning || null;
  res.locals.success = req.session.success || null;
  res.locals.denied = req.session.denied || null;

  res.locals.user = req.session.user || null;

  req.session.error = null;
  req.session.message = null;
  req.session.warning = null;
  req.session.success = null;
  req.session.denied = null;

  next();
});

// ==================== CLOUDINARY CONFIG ====================
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
  limits: { fileSize: 524288000 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed!"));
    }
    cb(null, true);
  }
});

// ==================== ROUTES ====================
app.use('/auth', authRoutes);
app.use('/customer', customerRoutes);
app.use('/admin', adminRoutes);

app.get('/', (req, res) => {
  res.redirect('/auth/login');
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});