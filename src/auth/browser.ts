/**
 * Open a URL in the system browser.
 *
 * Windows: `cmd /c start` truncates URLs at "&" (cmd metacharacter) when
 * spawned from Bun — rundll32 hands the URL to the default browser verbatim.
 */
export function openBrowser(url: string): void {
  if (process.platform === "win32") {
    Bun.spawn(["rundll32", "url.dll,FileProtocolHandler", url], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    return
  }
  const cmd = process.platform === "darwin" ? ["open", url] : ["xdg-open", url]
  Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
}
