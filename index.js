const cors = require("@fastify/cors");
const fastify = require('fastify')({ logger: true });


const PROXY_TO = process.env.PROXY_TO || 'https://network.ambrosus-dev.io';
const PORT = process.env.PORT || 8545;



// Start the server
async function main() {
  await fastify.register(cors, {origin: '*'});
  fastify.post('/', handler);
  await fastify.listen({ port: PORT });
  fastify.log.info(`Listening on port ${PORT}`);

}


function prepareUserRequest(request) {
  const isArr = Array.isArray(request.body);
  const userRequest = isArr ? request.body : [request.body];

  userRequest.forEach((req) => {
    req?.params?.forEach((p) => {
      if (p?.input) {
        p.data = p.input;
        delete p.input;
      }
      delete p?.chainId
    });
  });

  return { isArr, userRequest };
}

async function handler(request, reply) {
  console.log("Original user request:", JSON.stringify(request.body, undefined, 4));

  const { isArr, userRequest } = prepareUserRequest(request);
  const networkResponse = await sendToNetwork(userRequest);

  console.log(JSON.stringify(userRequest, undefined, 4), networkResponse)

  const fixed = await findAndFixErrors(userRequest, networkResponse);

  networkResponse.forEach((res) => {
    if (fixed[res.id])
      res.error = fixed[res.id];
  })

  reply.send(isArr ? networkResponse : networkResponse[0]);
}


async function findAndFixErrors(request, response) {

  const needToCallTxs = [];
  let fixedReverts = {  };

  for (const res of response) {
    if (!res.error) continue;

    const req = request.find((r) => r.id === res.id);
    if (!req) throw new Error(`Request ${res.id} not found`);

    // if it was a gas estimation or raw tx, we need to make a call to get the revert reason
    if (req.method === "eth_estimateGas" || req.method === "eth_sendRawTransaction") {
      if (res.error.data !== "Reverted") {
        console.warn('Error, but not "Reverted"', res);
        continue;
      }

      needToCallTxs.push({ ...req, method: "eth_call" });
    }

    // if it was a call, we need to parse the revert reason
    else if (req.method === "eth_call") {
      const fixedError = parseCallError(res.error);
      if (!fixedError) {
        console.warn("Can't parse error", res);
        continue;
      }

      fixedReverts[res.id] = fixedError;
    }

  }


  if (needToCallTxs.length > 0) {
    const networkResponse = await sendToNetwork(needToCallTxs);
    const fixed = await findAndFixErrors(needToCallTxs, networkResponse);
    fixedReverts = { ...fixedReverts, ...fixed };
  }


  return fixedReverts;

}


function parseCallError(error) {
  if (!error?.data?.startsWith("Reverted"))
    return;

  const reason = error.data.substring(9);

  const newError = {
    code: error.code,
    message: "execution reverted",
    data: reason
  }


  if (reason.startsWith("0x08c379a0")) {
    // https://github.com/authereum/eth-revert-reason/blob/e33f4df82426a177dbd69c0f97ff53153592809b/index.js#L93
    // "0x08c379a0" is `Error(string)` method signature, it's called by revert/require
    const parsed = hexToAscii(reason.substring(138)).replaceAll('\x00', '');
    newError.message  += `: Error("${parsed}")`;
  }
  else if (reason.startsWith("0x4e487b71")) {
    const parsed = hexToAscii(reason.substring(138)).replaceAll('\x00', '');
    newError.message += `: Panic("${parsed}")`;
  }

  return newError;
}



async function sendToNetwork(request) {
  const response = await fetch(PROXY_TO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  try {
    return response.json();
  } catch (e) {
    console.error("Error parsing response from original rpc", await response.text());
    throw e;
  }
}

const hexToAscii = (hex) => Buffer.from(hex, 'hex').toString('utf8')


main();
