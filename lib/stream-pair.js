'use strict';

// Preserve TCP half-closes and queued writes across an ssh2 forwarded channel.
// Channel.destroy() sends CLOSE immediately, even with writes waiting on the
// SSH window. A normal EOF must drain those writes before sending EOF/CLOSE.
function pairSocketChannel(socket, channel) {
  let aborted = false, sentEof = false, receivedEof = false;
  const abort = () => {
    if (aborted) return;
    aborted = true; socket.destroy(); channel.destroy();
  };
  const complete = () => {
    if (!aborted && sentEof && receivedEof) channel.end(() => channel.close());
  };
  socket.on('error', abort);
  channel.on('error', abort);
  socket.once('end', () => {
    if (aborted) return;
    // This callback runs after every preceding pipe write, including writes
    // held by SSH flow control. drain alone is not guaranteed to fire.
    channel.write(Buffer.alloc(0), (error) => {
      if (error) return abort();
      if (aborted) return;
      sentEof = true; channel.eof(); complete();
    });
  });
  channel.once('end', () => {
    receivedEof = true; socket.end(); complete();
  });
  socket.once('close', (hadError) => {
    if (hadError || !socket.readableEnded || !socket.writableFinished) abort();
  });
  channel.once('close', () => {
    if (aborted) return;
    if (!channel.readableEnded) return abort();
    socket.unpipe(channel);
    // A peer may fully close without waiting for our EOF. Flush the TCP tail
    // before closing that socket, rather than discarding its writable queue.
    if (!sentEof) socket.destroySoon(); else socket.end();
  });
  socket.pipe(channel, { end: false });
  channel.pipe(socket, { end: false });
}

module.exports = { pairSocketChannel };
