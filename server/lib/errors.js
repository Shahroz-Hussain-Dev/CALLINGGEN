'use strict';

class AppError extends Error {
  constructor(message, status = 500, code = 'internal_error', details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = status < 500;
  }
}
class ValidationError extends AppError {
  constructor(message, details) { super(message, 400, 'validation_error', details); }
}
class AuthError extends AppError {
  constructor(message = 'Authentication required') { super(message, 401, 'unauthorized'); }
}
class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to access this resource') { super(message, 403, 'forbidden'); }
}
class NotFoundError extends AppError {
  constructor(message = 'Not found') { super(message, 404, 'not_found'); }
}
class ConflictError extends AppError {
  constructor(message, details) { super(message, 409, 'conflict', details); }
}
class RateLimitError extends AppError {
  constructor(message = 'Too many attempts. Please wait and try again.') { super(message, 429, 'rate_limited'); }
}
class ServiceUnavailableError extends AppError {
  constructor(message, code = 'service_unavailable') { super(message, 503, code); }
}

module.exports = { AppError, ValidationError, AuthError, ForbiddenError, NotFoundError, ConflictError, RateLimitError, ServiceUnavailableError };
