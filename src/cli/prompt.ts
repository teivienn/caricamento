/**
 * Reads a secret from the TTY without echoing. In non-interactive mode
 * (CI, pipes) reads all of stdin instead.
 */
export async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }

  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (buf: Buffer) => {
      for (const byte of buf) {
        if (byte === 3) {
          cleanup();
          reject(new Error('Interrupted'));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (byte === 127) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    };
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}
