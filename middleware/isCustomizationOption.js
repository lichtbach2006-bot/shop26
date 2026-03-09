const CustomizationOption = require("../models/CustomizationOption");

const isCustomizationOption = async (req, res, next) => {
  try {
    const { customizationOptionId } = req.params;

    if (!customizationOptionId) {
      req.session.error = "Customization option ID is required.";
      return res.redirect("back");
    }

    const customizationOption = await CustomizationOption.findById(customizationOptionId);

    if (!customizationOption || customizationOption.isArchived) {
      req.session.error = "Customization option not found or has been archived.";
      return res.redirect("back");
    }

    req.customizationOption = customizationOption;
    next();
  } catch (err) {
    console.error("❌ isCustomizationOption middleware error:", err.message);
    req.session.error = "Something went wrong while validating the customization option.";
    return res.redirect("back");
  }
};

module.exports = isCustomizationOption;
