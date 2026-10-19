const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const { protect } = require("../middleware/auth");
const { issueCsrfToken, verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const {
  sendVerificationEmail,
  sendPasswordResetEmail,
  clientUrl,
} = require("../utils/email");
const router = express.Router();

// Emails cost quota and land in someone's inbox — keep resends rare
const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  handler: (req, res) =>
    sendError(res, 429, "Too many emails requested — please try again in an hour."),
});

const hashToken = (raw) =>
  crypto.createHash("sha256").update(String(raw)).digest("hex");

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  handler: (req, res) =>
    sendError(res, 429, "Too many attempts, please try again later."),
});

// Requests now arrive via the Next.js rewrite proxy (see next.config.ts),
// so from the browser's perspective every request is same-origin. That
// makes these cookies first-party, so plain "lax" works in both dev and prod.
const cookieBaseOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
};

// vendorVerified is included in the token so the frontend's middleware.ts
// can gate /dashboard on it without a DB round trip. Whenever
// vendorVerified changes (see routes/vendor.js /verify), the token must be
// re-signed via /api/auth/refresh for that change to actually take effect
// client-side — the DB value alone isn't enough since middleware only
// reads the token.
const signAccessToken = (id, userType, vendorVerified) =>
  jwt.sign(
    { id, userType, vendorVerified: !!vendorVerified },
    process.env.JWT_SECRET,
    {
      expiresIn: "2d",
    }
  );

const signRefreshToken = (id) =>
  jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, { expiresIn: "7d" });

const setAuthCookies = (res, user) => {
  const accessToken = signAccessToken(
    user._id,
    user.userType,
    user.vendorVerified
  );
  const refreshToken = signRefreshToken(user._id);

  res.cookie("accessToken", accessToken, {
    ...cookieBaseOptions,
    maxAge: 2 * 24 * 60 * 60 * 1000,
  });
  res.cookie("refreshToken", refreshToken, {
    ...cookieBaseOptions,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password]
 *             properties:
 *               name: { type: string }
 *               email: { type: string }
 *               password: { type: string }
 *               userType: { type: string, enum: [user, vendor] }
 *     responses:
 *       201:
 *         description: Account created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Email already in use
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post(
  "/register",
  authLimiter,
  issueCsrfToken,
  async (req, res, next) => {
    try {
      const { name, email, password, userType } = req.body;

      if (!name || !email || !password)
        return sendError(res, 400, "All fields required");

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email))
        return sendError(res, 400, "Invalid email format");

      if (password.length < 8)
        return sendError(res, 400, "Password must be at least 8 characters");

      const publicTypes = ["user", "vendor"];
      const resolvedType = publicTypes.includes(userType) ? userType : "user";

      const exists = await User.findOne({ email });
      if (exists) return sendError(res, 409, "Email already in use");

      const user = new User({
        name,
        email,
        password,
        userType: resolvedType,
      });
      const verifyToken = user.generateVerificationToken();
      await user.save();
      // Not awaited — signup shouldn't wait on the email provider; the user
      // can always ask for another link
      sendVerificationEmail(user, verifyToken);

      setAuthCookies(res, user);

      sendSuccess(res, 201, "Account created", {
        csrfToken: req.csrfToken,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          userType: user.userType,
          isVerified: user.isVerified,
          vendorVerified: user.vendorVerified,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Log in a user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Logged in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       400:
 *         description: Missing fields
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/login", authLimiter, issueCsrfToken, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return sendError(res, 400, "Email and password required");

    const user = await User.findOne({ email });
    if (!user || !(await user.matchPassword(password)))
      return sendError(res, 401, "Invalid credentials");

    setAuthCookies(res, user);

    sendSuccess(res, 200, "Logged in", {
      csrfToken: req.csrfToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        userType: user.userType,
        isVerified: user.isVerified,
        vendorVerified: user.vendorVerified,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/auth/verify-email/{token}:
 *   get:
 *     summary: Verify a user's email via token
 *     tags: [Auth]
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     description: >
 *       The emailed link opens this in a browser, which is redirected to
 *       CLIENT_URL/auth/login?verified=success (or ?verified=invalid). API clients
 *       asking for JSON get a JSON response instead.
 *     responses:
 *       200:
 *         description: Email verified
 *       302:
 *         description: Browser redirected to the login page
 *       400:
 *         description: Invalid or expired verification link
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/verify-email/:token", async (req, res, next) => {
  try {
    const user = await User.findOne({
      verificationToken: hashToken(req.params.token),
      verificationTokenExpires: { $gt: Date.now() },
    });

    if (user) {
      user.isVerified = true;
      user.verificationToken = undefined;
      user.verificationTokenExpires = undefined;
      await user.save();
    }

    if (req.accepts(["json", "html"]) === "html")
      return res.redirect(`${clientUrl()}/auth/login?verified=${user ? "success" : "invalid"}`);
    if (!user)
      return sendError(res, 400, "Invalid or expired verification link");
    sendSuccess(res, 200, "Email verified");
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/auth/resend-verification:
 *   post:
 *     summary: Email the logged-in user a fresh verification link
 *     tags: [Auth]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Link sent (or already verified)
 *       429:
 *         description: More than 5 emails requested in an hour
 */
router.post(
  "/resend-verification",
  emailLimiter,
  protect,
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      if (req.user.isVerified)
        return sendSuccess(res, 200, "Your email is already verified");

      const user = await User.findById(req.user._id);
      const token = user.generateVerificationToken();
      await user.save();
      await sendVerificationEmail(user, token);
      sendSuccess(res, 200, `We've sent a new link to ${user.email}`);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/auth/forgot-password:
 *   post:
 *     summary: Email a password reset link
 *     description: Always answers the same way, so it can't be used to find out which emails have accounts.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string }
 *     responses:
 *       200:
 *         description: Link sent if the account exists
 */
router.post("/forgot-password", emailLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const user = email ? await User.findOne({ email }) : null;
    if (user) {
      const token = user.generatePasswordResetToken();
      await user.save();
      sendPasswordResetEmail(user, token);
    }
    sendSuccess(res, 200, "If that email has an account, we've sent a reset link.");
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/auth/reset-password:
 *   post:
 *     summary: Set a new password using the emailed reset token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, password]
 *             properties:
 *               token: { type: string, description: The token from the reset link's ?token= }
 *               password: { type: string, minLength: 8 }
 *     responses:
 *       200:
 *         description: Password changed — log in with it
 *       400:
 *         description: Invalid or expired link, or password too short
 */
router.post("/reset-password", authLimiter, async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    if (typeof password !== "string" || password.length < 8)
      return sendError(res, 400, "Password must be at least 8 characters");

    const user = await User.findOne({
      passwordResetToken: hashToken(token),
      passwordResetExpires: { $gt: Date.now() },
    });
    if (!user)
      return sendError(res, 400, "This reset link is invalid or has expired. Ask for a new one.");

    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    // Opening the emailed link proves they own the address
    user.isVerified = true;
    await user.save();

    sendSuccess(res, 200, "Password changed — you can log in now");
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Refresh the access token using the refresh token cookie
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Token refreshed
 *       401:
 *         description: Invalid or expired refresh token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/refresh", async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (!token) return sendError(res, 401, "Not authorized");

  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.id).select("-password");
    if (!user) return sendError(res, 401, "User no longer exists");

    const accessToken = signAccessToken(
      user._id,
      user.userType,
      user.vendorVerified
    );
    res.cookie("accessToken", accessToken, {
      ...cookieBaseOptions,
      maxAge: 2 * 24 * 60 * 60 * 1000,
    });

    sendSuccess(res, 200, "Token refreshed");
  } catch {
    sendError(res, 401, "Invalid or expired refresh token");
  }
});

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Log out the current user
 *     tags: [Auth]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Logged out
 *       403:
 *         description: Invalid CSRF token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/logout", verifyCsrfToken, protect, (req, res) => {
  res.clearCookie("accessToken", cookieBaseOptions);
  res.clearCookie("refreshToken", cookieBaseOptions);
  res.clearCookie("csrfToken");
  sendSuccess(res, 200, "Logged out");
});

module.exports = router;
