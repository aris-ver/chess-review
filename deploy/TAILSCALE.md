# Reaching the review from anywhere (Tailscale)

Everything runs on the laptop; Tailscale gives the WSL box a private, encrypted IP that
your phone/other machines can reach without opening any ports. Nothing is public.

## One-time setup (in WSL)

```bash
curl -fsSL https://tailscale.com/install.sh | sh     # installs tailscale + tailscaled (systemd)
sudo tailscale up                                     # prints a login URL - open it, sign in
tailscale ip -4                                       # e.g. 100.101.102.103  <- your WSL box
```

Then install Tailscale on your phone / other laptop from the app store and sign in with
the same account. Open `http://<that ip>:8123/`.

Optional, a proper name + HTTPS on your tailnet (no port in the URL, works on any device):

```bash
sudo tailscale serve --bg 8123
# -> https://aris.<tailnet>.ts.net/
```

The first time, this prints a `https://login.tailscale.com/f/serve?...` link and waits: Serve has
to be enabled once per tailnet in the admin console. Open the link, approve, and the command
finishes. `--bg` persists the mapping in tailscaled's state, so it survives reboots; without `--bg`
it is cleared as soon as the terminal closes.

## Make the server survive reboots

```bash
sudo cp deploy/chess-review.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chess-review
systemctl status chess-review        # should say active (running)
```

From then on `bash scripts/restart_server.sh` is no longer needed; use
`sudo systemctl restart chess-review` after code changes.

The unit `Wants=`/`After=` `tailscaled.service`, so starting chess-review also brings the
tailnet up; `Restart=always` brings the server back after any exit.

WSL itself has to be running for any of this to be reachable, and it does not start by
itself after a Windows reboot. Create a Windows Task Scheduler task "At log on" (hidden,
no time limit) running:

    wsl.exe -d Ubuntu --exec /bin/sleep infinity

That boots the distro (systemd starts tailscaled + chess-review) and the attached `sleep`
stops WSL from idle-shutting the VM. From PowerShell:

    $a = New-ScheduledTaskAction -Execute wsl.exe -Argument '-d Ubuntu --exec /bin/sleep infinity'
    $t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $s = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
    Register-ScheduledTask 'WSL chess-review keepalive' -Action $a -Trigger $t -Settings $s

## Notes

- The server has no login of its own; Tailscale's device auth is the security boundary.
  Do not port-forward 8123 on your router.
- Analysis still uses the laptop's CPU, so it only works while the laptop is on and awake.
  Disable "sleep when lid closed" if you want it reachable with the lid shut.
- The Windows side (localhost:8123) keeps working as before.
