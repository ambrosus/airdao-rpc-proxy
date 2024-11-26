const cors = require("@fastify/cors");
const { ethers} = require("ethers");
const fastify = require('fastify')({ logger: true });


const PROXY_TO = process.env.PROXY_TO || 'https://network.ambrosus-dev.io';
const PORT = process.env.PORT || 8545;


const abiCoder = ethers.AbiCoder.defaultAbiCoder();

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
        p.data = p.input;  // viem use `input` instead of `data`
        delete p.input;
      }
      if (req.method === "eth_estimateGas") {
        delete p?.type; // remix sends this
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

  const response = isArr ? networkResponse : networkResponse[0];
  reply.send(response);
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
      if (res.error.data.startsWith("Reverted")) {
        needToCallTxs.push({ ...req, method: "eth_call" });
      }
      if (res.error.data.includes("Bad instruction")) {
        fixedReverts[res.id] = {
          code: res.error.code,
          message: `${res.error.data}. Most likely you need to change EVM version. Check documentation: https://docs.airdao.io/build-on-airdao/smart-contract-overview`,
          data: res.error.data
        }
      }
      else {
        console.warn("Error, not fixed", res);
      }
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
    const anotherFixedReverts = await findAndFixErrors(needToCallTxs, await sendToNetwork(needToCallTxs));
    fixedReverts = { ...fixedReverts, ...anotherFixedReverts };
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
    const parsed = abiCoder.decode(["string"], ethers.getBytes(reason).slice(4))[0];
    newError.message  += `: Error("${parsed}")`;
  }
  else if (reason.startsWith("0x4e487b71")) {
    const code = Number(abiCoder.decode(["uint256"], ethers.getBytes(reason).slice(4))[0]);
    newError.message += `: Panic(${code}) (${PanicReasons[code] ?? "Unknown panic code"})`;
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


const PanicReasons = {
  0x00: "GENERIC_PANIC",
  0x01: "ASSERT_FALSE",
  0x11: "OVERFLOW",
  0x12: "DIVIDE_BY_ZERO",
  0x21: "ENUM_RANGE_ERROR",
  0x22: "BAD_STORAGE_DATA",
  0x31: "STACK_UNDERFLOW",
  0x32: "ARRAY_RANGE_ERROR",
  0x41: "OUT_OF_MEMORY",
  0x51: "UNINITIALIZED_FUNCTION_CALL",
}

main();
