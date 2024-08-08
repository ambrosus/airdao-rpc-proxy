const fastify = require('fastify')({ logger: true });


const BACKEND_URL = process.env.BACKEND_URL || 'https://network.ambrosus-dev.io';
const PORT = process.env.PORT || 3000;



// Start the server
async function main() {
  fastify.post('/', handler);
  await fastify.listen({ port: PORT });
  fastify.log.info(`Listening on port ${PORT}`);

}


async function handler(request, reply) {
  const isArr = Array.isArray(request.body);
  const userRequest = isArr ? request.body : [request.body];
  const networkResponse = await sendToNetwork(userRequest);

  const fixed = await findAndFixErrors(userRequest, networkResponse);

  fixed.forEach((res) => {
    const resp = networkResponse.find((r) => r.id === res.id);
    resp.error.data = "execution reverted: " + res.reason;
  });

  reply.send(isArr ? networkResponse : networkResponse[0]);
}


async function findAndFixErrors(request, response) {

  const needToCallTxs = [];
  const fixedReverts = [];

  for (const res of response) {
    if (!res.error) continue;

    const req = request.find((r) => r.id === res.id);
    if (!req) throw new Error(`Request ${res.id} not found`);

    // if it was a gas estimation, we need to make a call to get the revert reason
    if (req.method === "eth_estimateGas") {
      if (res.error.data !== "Reverted") {
        console.warn('Error, but not "Reverted"', res);
        continue;
      }

      needToCallTxs.push({ ...req, method: "eth_call" });
    }

    // if it was a call, we need to parse the revert reason
    if (req.method === "eth_call") {
      const reason = parseCallError(res.error);
      if (!reason) {
        console.warn("Can't parse error", res);
        continue;
      }

      fixedReverts.push({ id: res.id, reason: reason });
    }

  }


  if (needToCallTxs.length > 0) {
    const networkResponse = await sendToNetwork(needToCallTxs);
    const fixed = await findAndFixErrors(needToCallTxs, networkResponse);
    fixedReverts.push(...fixed);
  }


  return fixedReverts;

}


function parseCallError(error) {
  if (!error.data.startsWith("Reverted 0x08c379a0"))
    return;

  // https://github.com/authereum/eth-revert-reason/blob/e33f4df82426a177dbd69c0f97ff53153592809b/index.js#L93
  // "0x08c379a0" is `Error(string)` method signature, it's called by revert/require
  let reason = error.data.substring(9);
  if (reason.length < 138 || !reason.startsWith("0x08c379a0")) {
    console.warn("Not error signature", reason);
    return;
  }

  return hexToAscii(reason.substring(138)).replaceAll('\x00', '');
}



async function sendToNetwork(request) {
  const response = await fetch(BACKEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  return response.json();
}

const hexToAscii = (hex) => Buffer.from(hex, 'hex').toString('utf8')


main();
