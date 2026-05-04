const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'hotelease_secret_key';

// ── Verify JWT token ───────────────────────────────────────────
function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    // Auto-inject hotelId into query if not super_admin
    if (!req.query.hotelId && decoded.hotelId) {
      req.query.hotelId = decoded.hotelId;
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Require specific role ──────────────────────────────────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  };
}

// ── Ensure hotel access (can't access other hotel's data) ──────
function ensureHotelAccess(req, res, next) {
  const { user } = req;
  if (user.role === 'super_admin') return next();
  const requestedHotelId = req.query.hotelId || req.body.hotelId || req.params.hotelId;
  if (requestedHotelId && requestedHotelId !== user.hotelId) {
    return res.status(403).json({ error: 'Access denied to this hotel data' });
  }
  // Force hotel ID to logged in hotel
  req.query.hotelId = user.hotelId;
  if (req.body) req.body.hotelId = user.hotelId;
  next();
}

module.exports = { authenticate, requireRole, ensureHotelAccess };
