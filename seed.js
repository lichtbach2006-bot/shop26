require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

// Models
const User = require("./models/User");
const Product = require("./models/Product");

// ==================== SEED DATA ====================

const seedUsers = [
  {
    firstName: "KDY",
    lastName: "Admin",
    email: "admin@kdy.com",
    password: "admin123",
    phoneNumber: "09171234567",
    address: "KDY Arts & Crafts HQ, Manila, Philippines",
    role: "admin",
    status: "active",
  },
  {
    firstName: "Juan",
    lastName: "Dela Cruz",
    email: "juan@gmail.com",
    password: "customer123",
    phoneNumber: "09181234567",
    address: "123 Rizal St, Quezon City, Philippines",
    role: "customer",
    status: "active",
  },
  {
    firstName: "Maria",
    lastName: "Santos",
    email: "maria@gmail.com",
    password: "customer123",
    phoneNumber: "09191234567",
    address: "456 Mabini Ave, Makati City, Philippines",
    role: "customer",
    status: "active",
  },
];

const seedProducts = [
  {
    name: "Personalized Photo Mug",
    category: "mug",
    description: "Customizable ceramic mug with your favorite photo printed in high quality. Perfect for gifts and keepsakes!",
    basePrice: 250,
    stock: 50,
    imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/sample_mug.jpg",
    sizes: ["11oz", "15oz"],
    colors: ["white", "black"],
    status: "available",
  },
  {
    name: "Acrylic Name Keychain",
    category: "keychain",
    description: "Custom-cut acrylic keychain with your name or design. Lightweight and durable!",
    basePrice: 120,
    stock: 100,
    imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/sample_keychain.jpg",
    sizes: [],
    colors: ["clear", "gold", "silver", "rose gold"],
    status: "available",
  },
  {
    name: "Custom Print T-Shirt",
    category: "shirt",
    description: "Premium cotton t-shirt with your custom design printed using DTF technology. Vibrant and long-lasting!",
    basePrice: 450,
    stock: 30,
    imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/sample_shirt.jpg",
    sizes: ["S", "M", "L", "XL", "2XL"],
    colors: ["white", "black", "navy", "gray"],
    status: "available",
  },
  {
    name: "Insulated Tumbler with Name",
    category: "tumbler",
    description: "Stainless steel insulated tumbler with custom name engraving. Keeps drinks hot or cold for hours!",
    basePrice: 550,
    stock: 25,
    imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/sample_tumbler.jpg",
    sizes: ["20oz", "30oz"],
    colors: ["black", "white", "pink", "blue", "green"],
    status: "available",
  },
  {
    name: "Resin Photo Keychain",
    category: "keychain",
    description: "Handcrafted resin keychain with embedded photo. Waterproof and scratch-resistant!",
    basePrice: 180,
    stock: 60,
    imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/sample_resin.jpg",
    sizes: [],
    colors: ["clear", "blue glitter", "pink glitter"],
    status: "available",
  },
  {
    name: "Couple Mug Set",
    category: "mug",
    description: "Set of 2 matching mugs with custom couple design. Perfect anniversary or wedding gift!",
    basePrice: 480,
    stock: 20,
    imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/sample_couple_mug.jpg",
    sizes: ["11oz"],
    colors: ["white"],
    status: "available",
  },
  {
    name: "Customized Tote Bag",
    category: "others",
    description: "Eco-friendly canvas tote bag with your custom design. Great for everyday use!",
    basePrice: 350,
    stock: 40,
    imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/sample_tote.jpg",
    sizes: [],
    colors: ["natural", "black", "navy"],
    status: "available",
  },
  {
    name: "Graduation Tumbler",
    category: "tumbler",
    description: "Special edition tumbler for graduates. Add name, course, and graduation year!",
    basePrice: 600,
    stock: 0,
    imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/sample_grad_tumbler.jpg",
    sizes: ["20oz", "30oz"],
    colors: ["black", "maroon", "gold"],
    status: "out_of_stock",
  },
];

// ==================== RUN SEED ====================

async function seed() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to database");

    // ---------- SEED USERS ----------
   // Sa loob ng seed() function mo:
console.log("\n👤 Seeding users...");
for (const userData of seedUsers) {
  // 1. Siguraduhin nating malinis ang email
  const cleanEmail = userData.email.toLowerCase();

  const exists = await User.findOne({ email: cleanEmail });
  if (exists) {
    console.log(`  ⏭️  ${cleanEmail} already exists, skipping`);
    continue;
  }

  // 2. Hash ang password
  const hashedPassword = await bcrypt.hash(userData.password, 12);

  // 3. I-create ang user gamit ang tamang fields
  await User.create({
    firstName: userData.firstName,
    lastName: userData.lastName,
    email: cleanEmail,
    password: hashedPassword,
    phoneNumber: userData.phoneNumber,
    address: userData.address,
    role: userData.role,
    status: "active",
    isArchived: false // 👈 Explicitly set this!
  });

  console.log(`  ✅ Created ${userData.role}: ${cleanEmail}`);
}

    // ---------- SEED PRODUCTS ----------
    console.log("\n📦 Seeding products...");
    const productCount = await Product.countDocuments({ isArchived: false });
    if (productCount > 0) {
      console.log(`   ⏭️  ${productCount} products already exist, skipping`);
    } else {
      for (const productData of seedProducts) {
        await Product.create(productData);
        console.log(`   ✅ Created: ${productData.name} (₱${productData.basePrice})`);
      }
    }

    // ---------- SUMMARY ----------
    console.log("\n🎉 ========== SEED COMPLETE ==========");
    console.log("   Test Accounts:");
    console.log("   ┌────────────────────────────────────────┐");
    console.log("   │  ADMIN                                 │");
    console.log("   │  Email:    admin@kdy.com               │");
    console.log("   │  Password: admin123                    │");
    console.log("   ├────────────────────────────────────────┤");
    console.log("   │  CUSTOMER 1                            │");
    console.log("   │  Email:    juan@gmail.com              │");
    console.log("   │  Password: customer123                 │");
    console.log("   ├────────────────────────────────────────┤");
    console.log("   │  CUSTOMER 2                            │");
    console.log("   │  Email:    maria@gmail.com             │");
    console.log("   │  Password: customer123                 │");
    console.log("   └────────────────────────────────────────┘");
    console.log(`   Products: ${await Product.countDocuments({ isArchived: false })} total`);
    console.log("   =====================================\n");

    process.exit(0);
  } catch (err) {
    console.error("❌ Seed error:", err.message);
    process.exit(1);
  }
}

seed();
