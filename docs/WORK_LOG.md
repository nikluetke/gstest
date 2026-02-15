Work log - Gameserver Manager MVP

2026-02-15 09:32 CET - Task: Build and deploy MVP on this server (per user instruction)
Actions taken:
1) Decided stack: Node.js Express API, Docker Compose, simple static frontend (nginx), Postgres placeholder.
2) Scaffolding files created in workspace:
   - docker-compose.yml
   - api/ (Dockerfile, package.json, index.js)
   - frontend/ (Dockerfile, index.html)
   - README.md
   - docs/WORK_LOG.md (this file)
3) API design decisions:
   - Control Docker via mounted /var/run/docker.sock in api container.
   - Label managed containers with label 'gs_manager=1'.
   - Provide simple endpoints: list/create/start/stop/remove.

Security notes & caution:
- Mounting the Docker socket gives the API full control over the host Docker daemon. This is acceptable for an MVP on a trusted single-user server but must be hardened for production.
- Consider using a privileged helper-daemon with restricted commands or a socket-proxy for production.

Next steps performed: Attempting to build and start the composition.

2026-02-15 10:16 CET - Installed Docker Compose CLI plugin (v2.20.2) and started first Minecraft server
Actions taken:
- Installed docker compose plugin to /usr/local/lib/docker/cli-plugins/docker-compose
- Created directory /opt/games/minecraft1 for persistent server data
- Started a Minecraft server container using image itzg/minecraft-server:latest with:
  docker run -d --name minecraft1 --label gs_manager=1 -p 25565:25565 -e EULA=TRUE -e MEMORY=1G -v /opt/games/minecraft1:/data itzg/minecraft-server:latest

Result / Status:
- Image pull completed and container created: container id 2ecfddc972d1
- Docker reports the container as: Up 2 minutes (healthy)
- Ports: 0.0.0.0:25565->25565/tcp
- Logs show server startup completed and server reported "Done" (1.21.11) and RCON listening on port 25575. World created (no existing world data).

Excerpt from logs (important lines):
- Starting Minecraft server version 1.21.11
- Starting Minecraft server on *:25565
- Done (5.269s)! For help, type "help"
- RCON running on 0.0.0.0:25575

Notes:
- Server is reachable on the host's IP at port 25565 from public/private network depending on firewall.
- Next: integrate this server into the API's listing (it already has label gs_manager=1), implement console/websocket, backups, and auth.

