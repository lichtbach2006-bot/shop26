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

// Index used by the admin analytics aggregations (no field changes)
shippingSchema.index({ orderId: 1 });

module.exports = mongoose.model("Shipping", shippingSchema);
