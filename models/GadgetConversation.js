const mongoose = require("mongoose");

// A saved gadget-recommender chat for a logged-in user. Assistant turns are
// stored as the JSON reply string, exactly as the model produced it, so the
// history can be replayed to the model unchanged on the next turn.
const GadgetConversationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: { type: String, required: true, maxlength: 100 },
    messages: [
      {
        _id: false,
        role: { type: String, enum: ["user", "assistant"], required: true },
        content: { type: String, required: true },
      },
    ],
  },
  { timestamps: true }
);

GadgetConversationSchema.index({ user: 1, updatedAt: -1 });

module.exports = mongoose.model("GadgetConversation", GadgetConversationSchema);
