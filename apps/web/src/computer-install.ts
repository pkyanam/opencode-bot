const scripts = "https://raw.githubusercontent.com/pkyanam/opencode-bot/main/scripts";
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const powershell = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function computerInstallCommand(platform: "unix" | "windows", origin: string, token: string): string {
  if (platform === "windows") {
    return `$installer = Join-Path $env:TEMP 'opencode-node-install.ps1'; Invoke-WebRequest '${scripts}/node-install.ps1' -OutFile $installer; & $installer -ControlUrl ${powershell(origin)} -PairingToken ${powershell(token)} -Name $env:COMPUTERNAME; Remove-Item $installer`;
  }
  return `curl -fsSL '${scripts}/node-install.sh' | bash -s -- --control-url ${shell(origin)} --pairing-token ${shell(token)} --name "$(hostname)"`;
}
