const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: [true, "Order ID is required"],
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: [true, "Product ID is required"],
    },
    quantity: {
      type: Number,
      required: [true, "Quantity is required"],
      min: 1,
      default: 1,
    },
    itemPrice: {
      type: Number,
      required: [true, "Item price is required"],
      min: 0,
    },
    selectedSize: {
      type: String,
      default: null,
    },
    selectedColor: {
      type: String,
      default: null,
    },
    customText: {
      type: String,
      default: null,
      trim: true,
    },
    customImageUrl: {
      type: String,
      default: null,
    },
    subtotal: {
      type: Number,
      required: [true, "Subtotal is required"],
      min: 0,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "ready", "shipped", "delivered", "cancelled"],
      default: "pending",
    },
    isArchived: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("OrderItem", orderItemSchema);
