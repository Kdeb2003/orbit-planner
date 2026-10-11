// Preloaded with `node --import` by hosted-courses-script.test.ts: any attempt to open a connection or call fetch ends the
// process with a recognisable marker, so a "--dry-run" that is not truly offline is caught.
import net from 'node:net'

const stop = () => {
  process.stderr.write('NETWORK-ATTEMPT\n')
  process.exit(99)
}
globalThis.fetch = stop
net.Socket.prototype.connect = stop
