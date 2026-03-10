function errorHandler(err, _req, res, _next) {
  console.error(err.stack || err);

  const status = err.status || 500;
  const message =
    status === 500 ? 'Internal server error' : err.message || 'Something went wrong';

  res.status(status).json({ error: message });
}

module.exports = errorHandler;
