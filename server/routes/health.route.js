const router = require('express').Router();
const lock = require('../state/lock');

router.get('/', (req, res) => {
  res.json({ ok: true, busy: lock.isBusy() });
});

module.exports = router;
