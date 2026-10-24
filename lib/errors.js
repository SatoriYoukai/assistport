'use strict';

class SupportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SupportError';
    this.code = code;
    Object.assign(this, details);
  }
}
const failure = (code, message, details) => new SupportError(code, message, details);
module.exports = { SupportError, failure };
