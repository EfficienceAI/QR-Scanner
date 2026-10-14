'use strict';

/**
 * Apple pass web service: device registration.
 *   POST   /v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber  { pushToken }
 *   DELETE /v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber
 * Auth: "Authorization: ApplePass <authenticationToken>".
 */

const members = require('../../../../../../../lib/members');
const { send, query, readBody, authorize, log } = require('../../../../../../../lib/wallet');

function createHandler(deps = {}) {
  return async function handler(req, res) {
    const q = query(req);
    const { deviceId, passTypeId, serial } = q;
    try {
      const member = await authorize(req, passTypeId, serial, deps);
      if (!member) return send(res, 401);
      if (req.method === 'POST') {
        const pushToken = String(readBody(req).pushToken || '');
        if (!pushToken) return send(res, 400);
        const { created } = await (deps.registerDevice || members.registerDevice)({ deviceId, serial, pushToken }, deps);
        log('register', { serial, deviceId: String(deviceId).slice(0, 8), created });
        return send(res, created ? 201 : 200);
      }
      if (req.method === 'DELETE') {
        await (deps.unregisterDevice || members.unregisterDevice)({ deviceId, serial }, deps);
        log('unregister', { serial, deviceId: String(deviceId).slice(0, 8) });
        return send(res, 200);
      }
      res.setHeader('Allow', 'POST, DELETE');
      return send(res, 405);
    } catch (err) {
      log('error', { route: 'registration', message: err.message, status: err.status });
      return send(res, err.status === 0 ? 503 : 500);
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
