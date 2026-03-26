const mongoose = require("mongoose");

const shippingSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: [true, "Order ID is required"],
    },
    courierName: {
      type: String,
      required: false,
      trim: true,
    },
    trackingNumber: {
      type: String,
      required: false,
      unique: true,
      trim: true,
    },
    shippingStatus: {
      type: String,
      enum: ["preparing", "shipped", "in_transit", "delivered"],
      default: "preparing",
    },
    estimatedDelivery: {
      type: Date,
      required: [true, "Estimated delivery date is required"],
    },
    deliveredAt: {
      type: Date,
      default: null,
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

module.exports = mongoose.model("Shipping", shippingSchema);
