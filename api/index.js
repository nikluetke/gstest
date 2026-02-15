const express = require('express');
const bodyParser = require('body-parser');
const Docker = require('dockerode');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const docker = new Docker({socketPath: '/var/run/docker.sock'});
const app = express();
app.use(cors());
app.use(bodyParser.json());

// helper to map container info
async function containerToServer(c) {
  const info = await c.inspect();
  return {
    id: info.Id.slice(0,12),
    name: (info.Name || '').replace(/^\//,''),
    status: info.State.Status + (info.State.Health && info.State.Health.Status ? ' ('+info.State.Health.Status+')' : ''),
    image: info.Config.Image
  };
}

// List containers managed by label 'gs_manager=1'
app.get('/servers', async (req, res) => {
  try{
    const containers = await docker.listContainers({all:true, filters: {label: ['gs_manager=1']}});
    const servers = await Promise.all(containers.map(async c => {
      const container = docker.getContainer(c.Id);
      return containerToServer(container);
    }));
    res.json({ servers });
  }catch(err){
    res.status(500).json({ error: err.message });
  }
});

// helper: find a free host port starting at base
async function findFreePort(base){
  const containers = await docker.listContainers({all:true});
  const used = new Set();
  containers.forEach(c => {
    (c.Ports||[]).forEach(p => { if(p.PublicPort) used.add(p.PublicPort); });
  });
  let port = base;
  while(used.has(port)) port++;
  return port.toString();
}

// Create a new placeholder game container (image + name)
app.post('/servers/create', async (req, res) => {
  const { name, image } = req.body;
  if (!name || !image) return res.status(400).json({ error: 'name and image required' });
  try{
    // template heuristics: if image looks like minecraft, expose 25565, else no host binding
    const isMinecraft = image.toLowerCase().includes('minecraft') || image.toLowerCase().includes('itzg/minecraft');
    const opts = {
      Image: image,
      name: name,
      Labels: { gs_manager: '1' },
      HostConfig: {
        RestartPolicy: { Name: 'no' },
        Binds: [`/opt/games/${name}:/data`]
      }
    };
    if(isMinecraft){
      const hostPort = await findFreePort(25565);
      opts.ExposedPorts = { '25565/tcp': {} };
      opts.HostConfig.PortBindings = { '25565/tcp': [{ HostPort: hostPort }] };
    }
    const container = await docker.createContainer(opts);
    await container.start();
    res.json({ id: container.id });
  }catch(err){
    res.status(500).json({ error: err.message });
  }
});

app.post('/servers/:name/start', async (req, res) => {
  const name = req.params.name;
  try{
    const containers = await docker.listContainers({all:true, filters:{name:[name]}});
    if(!containers.length) return res.status(404).json({ error: 'not found' });
    const c = docker.getContainer(containers[0].Id);
    await c.start();
    res.json({ result: 'started' });
  }catch(err){ res.status(500).json({ error: err.message }); }
});

app.post('/servers/:name/stop', async (req, res) => {
  const name = req.params.name;
  try{
    const containers = await docker.listContainers({all:true, filters:{name:[name]}});
    if(!containers.length) return res.status(404).json({ error: 'not found' });
    const c = docker.getContainer(containers[0].Id);
    await c.stop();
    res.json({ result: 'stopped' });
  }catch(err){ res.status(500).json({ error: err.message }); }
});

app.post('/servers/:name/remove', async (req, res) => {
  const name = req.params.name;
  try{
    const containers = await docker.listContainers({all:true, filters:{name:[name]}});
    if(!containers.length) return res.status(404).json({ error: 'not found' });
    const c = docker.getContainer(containers[0].Id);
    await c.remove({force:true});
    res.json({ result: 'removed' });
  }catch(err){ res.status(500).json({ error: err.message }); }
});

// Logs (last lines)
app.get('/servers/:name/logs', async (req, res) => {
  const name = req.params.name;
  try{
    const containers = await docker.listContainers({all:true, filters:{name:[name]}});
    if(!containers.length) return res.status(404).json({ error: 'not found' });
    const c = docker.getContainer(containers[0].Id);
    const stream = await c.logs({stdout:true, stderr:true, tail: 200});
    // stream is a Buffer
    res.setHeader('Content-Type','text/plain; charset=utf-8');
    res.send(stream.toString());
  }catch(err){ res.status(500).json({ error: err.message }); }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', async function connection(ws, req) {
  // support ?name=...&type=console|logs
  const params = new URLSearchParams(req.url.replace(/^.*\?/,'') );
  const name = params.get('name');
  const type = params.get('type') || 'console';
  if(!name){ ws.close(1008,'name required'); return }
  try{
    const containers = await docker.listContainers({all:true, filters:{name:[name]}});
    if(!containers.length){ ws.close(1008,'not found'); return }
    const c = docker.getContainer(containers[0].Id);

    if(type === 'logs'){
      // stream logs (follow)
      const logStream = await c.logs({stdout:true,stderr:true,follow:true,tail:200});
      logStream.on('data', chunk => {
        try{ ws.send(chunk.toString()); }catch(e){}
      });
      ws.on('close', ()=>{ try{ logStream.destroy(); }catch(e){} });
      return;
    }

    // console (exec /bin/sh)
    const execInst = await c.exec({Cmd:['/bin/sh'],AttachStdin:true,AttachStdout:true,AttachStderr:true,Tty:true});
    const stream = await execInst.start({hijack:true,stdin:true});
    // ensure websocket messages are sent as input
    ws.on('message', msg => { try{ if(typeof msg === 'string') stream.write(msg); else stream.write(msg); }catch(e){} });
    stream.on('data', d=>{ try{ ws.send(d); }catch(e){} });
    ws.on('close', ()=>{ try{ stream.end(); }catch(e){} });
  }catch(err){ ws.close(1011, err.message); }
});

server.listen(process.env.PORT || 3000, () => console.log('API listening on port', process.env.PORT || 3000));
