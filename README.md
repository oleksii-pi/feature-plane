Run the server with a plain Node process:

```sh
node server.js 3000
```

Replace `3000` with the feature port when one is assigned, for example:

```sh
node server.js 61666
```

In sandboxed environments, starting a localhost server may require approval because the process binds to `127.0.0.1`.

Start in watch mode:

```sh
node --watch --watch-path=server server.js 3000
```
