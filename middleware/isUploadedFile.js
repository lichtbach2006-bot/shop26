const UploadedFile = require("../models/UploadedFile");

const isUploadedFile = async (req, res, next) => {
  try {
    const { uploadedFileId } = req.params;

    if (!uploadedFileId) {
      req.session.error = "Uploaded file ID is required.";
      return res.redirect("back");
    }

    const uploadedFile = await UploadedFile.findById(uploadedFileId);

    if (!uploadedFile || uploadedFile.isArchived) {
      req.session.error = "Uploaded file not found or has been archived.";
      return res.redirect("back");
    }

    // Customer can only access their own uploaded files (inspo photos, etc.)
    // Admin can access any uploaded file (for processing orders)
    if (
      req.session.user.role === "customer" &&
      uploadedFile.userId.toString() !== req.session.user._id.toString()
    ) {
      req.session.denied = "Access denied. You can only manage your own uploaded files.";
      return res.redirect("back");
    }

    req.uploadedFile = uploadedFile;
    next();
  } catch (err) {
    console.error("❌ isUploadedFile middleware error:", err.message);
    req.session.error = "Something went wrong while validating the uploaded file.";
    return res.redirect("back");
  }
};

module.exports = isUploadedFile;
