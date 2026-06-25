# Federation Session

`@mikkel-ol/federation-session` connects Angular Native Federation development
servers through YATSI. A host opens a public session and remote applications
join it using the generated Session URL.

## Compatibility

Version 22 supports Angular 22 and Native Federation 22.

## Setup

```sh
npm install --save-dev @mikkel-ol/federation-session
ng generate @mikkel-ol/federation-session:setup \
  --project host \
  --role host \
  --yatsi-server-url https://tunnel.example.com
```

For a remote:

```sh
ng generate @mikkel-ol/federation-session:setup \
  --project participant \
  --role remote
ng serve participant --session-url https://session.tunnel.example.com?join=...
```

The generator supports standalone Angular applications. It preserves an
existing Native Federation setup or invokes Native Federation's official
generator for plain Angular CLI applications.

Host setup replaces the root template with a styled session stage:

```html
<federation-session-stage heading="Federated Session"></federation-session-stage>
```

Change the `heading` attribute or bind the `heading` property to rename the
stage in the host application.
