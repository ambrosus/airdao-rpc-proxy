## Airdao-RPC-proxy

Proxy rpc requests to specified url, but make errors readable.


### Launch

```
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
            "message": "VM execution error.",
            "data": "execution reverted: AccessControl: account 0x15d62f4fd835a800b8e5ab77669f93f6af8e419c is missing role 0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6"
        },
        "id": 1
    },
    {
        "jsonrpc": "2.0",
        "error": {
            "code": -32016,
            "message": "The execution failed due to an exception.",
            "data": "execution reverted: AccessControl: account 0x15d62f4fd835a800b8e5ab77669f93f6af8e419c is missing role 0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6"
        },
        "id": 2
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
            "data": "Reverted 0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000094416363657373436f6e74726f6c3a206163636f756e7420307831356436326634666438333561383030623865356162373736363966393366366166386534313963206973206d697373696e6720726f6c6520307839663264663066656432633737363438646535383630613463633530386364303831386338356238623861316162346365656566386439383163383935366136000000000000000000000000"
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
    }
]
```


Request:

```json
[
    {
        "id": 1,
        "jsonrpc": "2.0",
        "method": "eth_call",
        "params": [
            {
                "data": "0x3a4b66f1",
                "from": "0x281DCd7124B1b6015B6C7953C9E4aE19d8d63A89",
                "to": "0x15d62f4Fd835a800B8e5AB77669F93F6Af8E419c",
                "value": "0x56bc75e2d63100000"
            }
        ]
    },
    {
        "id": 2,
        "jsonrpc": "2.0",
        "method": "eth_estimateGas",
        "params": [
            {
                "data": "0x3a4b66f1",
                "from": "0x281DCd7124B1b6015B6C7953C9E4aE19d8d63A89",
                "to": "0x15d62f4Fd835a800B8e5AB77669F93F6Af8E419c",
                "value": "0x56bc75e2d63100000"
            }
        ]
    }
]
```
