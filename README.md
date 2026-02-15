MVP: Gameserver Manager (zapclaw)

Overview
- This workspace contains an MVP for a container-based Game Server Manager.
- Components: API (Express) that can list/create/start/stop game containers via Docker socket; Frontend: minimal static page.
- Deployment: docker-compose.yml runs: postgres (for future use), api, frontend, and a placeholder game container template.

What's included
- docker-compose.yml — orchestration for dev/prod on this host
- api/ — Node.js Express API that exposes endpoints: /servers (list), /servers/create, /servers/:id/start, /stop
- frontend/ — minimal static UI (placeholder)
- docs/WORK_LOG.md — logs of actions performed and decisions

How to run (on this host)
- The assistant has attempted to start the composition. To start manually:
  sudo /usr/local/bin/zapclaw-exec docker compose up -d --build

Security note
- The API binds the Docker socket (/var/run/docker.sock) into the api container so the API can control Docker. This grants the API root-equivalent control of Docker on the host. For production, restrict this via a small privileged helper, socket-proxy with ACLs, or run the manager outside containers with controlled sudoers commands.

Next steps
- Implement persistent DB use and auth
- Add xterm.js console via websocket to expose container logs and attach to container TTY
- Implement templates for common games (Minecraft, CS:GO) and installers (steamcmd)

