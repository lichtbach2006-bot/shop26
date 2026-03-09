const mongoose = require("mongoose");

const customizationOptionSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: [true, "Product ID is required"],
    },
    optionType: {
      type: String,
      required: [true, "Option type is required"],
      enum: ["text", "imageUpload", "color", "engraving"],
    },
    label: {
      type: String,
      required: [true, "Label is required"],
      trim: true,
    },
    additionalPrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    required: {
      type: Boolean,
      default: false,
    },
    maxTextLength: {
      type: Number,
      default: null,
    },
    allowedFileTypes: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
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

module.exports = mongoose.model("CustomizationOption", customizationOptionSchema);
