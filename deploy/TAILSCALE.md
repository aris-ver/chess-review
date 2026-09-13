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

## Make the server survive reboots

```bash
sudo cp deploy/chess-review.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chess-review
systemctl status chess-review        # should say active (running)
```

From then on `bash scripts/restart_server.sh` is no longer needed; use
`sudo systemctl restart chess-review` after code changes.

WSL itself has to be running for any of this to be reachable. It stays up while the
service runs, but does not start by itself after a Windows reboot. To fix that, create a
Windows Task Scheduler task "At log on" running:

    wsl.exe -d Ubuntu -- true

(that boots the distro, systemd starts tailscaled + chess-review, and the VM stays up).

## Notes

- The server has no login of its own; Tailscale's device auth is the security boundary.
  Do not port-forward 8123 on your router.
- Analysis still uses the laptop's CPU, so it only works while the laptop is on and awake.
  Disable "sleep when lid closed" if you want it reachable with the lid shut.
- The Windows side (localhost:8123) keeps working as before.
