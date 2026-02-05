import config from '../../utils/config.js';

/**
 * Authentication middleware
 * Validates X-Auth-Token header against configured tokens
 */
export function authMiddleware(req, res, next) {
  // Skip auth if no tokens configured
  if (config.auth.tokens.length === 0) {
    return next();
  }

  const token = req.get(config.auth.header);

  if (!token) {
    return res.status(401).json({
      error: 'Authentication required',
      message: `Missing ${config.auth.header} header`,
    });
  }

  if (!config.auth.tokens.includes(token)) {
    return res.status(401).json({
      error: 'Authentication failed',
      message: 'Invalid authentication token',
    });
  }

  next();
}

export default authMiddleware;
