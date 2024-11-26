## Airdao-RPC-proxy

Proxy rpc requests to specified url, but make errors readable.


### Launch

```
npm i
PROXY_TO=https://network.ambrosus-dev.io PORT=8080 node ./index.js
```

Env vars:
- `PROXY_TO` - url to proxy requests to   
- `PORT` - port to listen on


### Why


Response **WITH** proxy:


```json
[
  {
    "jsonrpc": "2.0",
    "error": {
      "code": -32015,
      "message": "execution reverted: Error(\"You can't withdraw yet\")",
      "data": "0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000016596f752063616e27742077697468647261772079657400000000000000000000"
    },
    "id": 1
  },
  {
    "jsonrpc": "2.0",
    "error": {
      "code": -32015,
      "message": "execution reverted: Error(\"You can't withdraw yet\")",
      "data": "0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000016596f752063616e27742077697468647261772079657400000000000000000000"
    },
    "id": 2
  },
  {
    "jsonrpc": "2.0",
    "error": {
      "code": -32016,
      "message": "Bad instruction 5f. Most likely you need to change EVM version. Check documentation: https://docs.airdao.io/build-on-airdao/smart-contract-overview",
      "data": "Bad instruction 5f"
    },
    "id": 3
  }
]
```


Response **WITHOUT** proxy:

```json
[
  {
    "jsonrpc": "2.0",
    "error": {
      "code": -32015,
      "message": "VM execution error.",
      "data": "Reverted 0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000016596f752063616e27742077697468647261772079657400000000000000000000"
    },
    "id": 1
  },
  {
    "jsonrpc": "2.0",
    "error": {
      "code": -32016,
      "message": "The execution failed due to an exception.",
      "data": "Reverted"
    },
    "id": 2
  },
  {
    "jsonrpc": "2.0",
    "error": {
      "code": -32016,
      "message": "The execution failed due to an exception.",
      "data": "Bad instruction 5f"
    },
    "id": 3
  }
]
```


Request (AirDao testnet):
```json
[
  {
    "id": 1,
    "jsonrpc": "2.0",
    "method": "eth_call",
    "params": [
      {
        "from": "0x1111472fca4260505ece4acd07717cada41c1111",
        "to": "0x83286207525393bf953d0dbeaa0dcf84cb45dfc2",
        "data": "0x3ccfd60b"
      }
    ]
  },
  {
    "id": 2,
    "jsonrpc": "2.0",
    "method": "eth_estimateGas",
    "params": [
      {
        "from": "0x1111472fca4260505ece4acd07717cada41c1111",
        "to": "0x83286207525393bf953d0dbeaa0dcf84cb45dfc2",
        "data": "0x3ccfd60b"
      }
    ]
  },
  {
    "id": 3,
    "jsonrpc": "2.0",
    "method": "eth_estimateGas",
    "params": [
      {
        "from": "0x1111472FCa4260505EcE4AcD07717CADa41c1111",
        "data": "0x6080604052348015600e575f5ffd5b50603e80601a5f395ff3fe60806040525f5ffdfea2646970667358221220055a6933dcf2fddefe542a784740c2f2ac67948ced73c273c2f9f2748e7e303164736f6c634300081c0033",
        "value": "0x0"
      },
      "latest"
    ]
  }
]
```
