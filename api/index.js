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

// Templates
const TEMPLATES = {
  minecraft: { id:'minecraft', name:'Minecraft (itzg)', image:'itzg/minecraft-server:latest', ports:[25565], env:{EULA:'TRUE', MEMORY:'1G'} },
  csgo: { id:'csgo', name:'CS:GO (SteamCMD)', image:'cm2network/steamcmd:root', ports:[27015], env:{STEAM_ACCOUNT:'', SRCDS_TOKEN:''}, cmd:null },
  valheim: { id:'valheim', name:'Valheim', image:'llnl/valheim-server:latest', ports:[2456,2457], env:{NAME:'Valheim', WORLD:'world', PORT:'2456'} },
  rust: { id:'rust', name:'Rust', image:'xtrarama/rust-server:latest', ports:[28015], env:{RUST_SERVER_NAME:'RustServer'} },
  alpine: { id:'alpine', name:'Alpine', image:'alpine:3.18', ports:[], env:{} }
};
app.get('/templates',(req,res)=> res.json({ templates: Object.values(TEMPLATES) }));

// List containers managed by label 'gs_manager=1'
app.get('/servers', async (req, res) => {
  try{
    const containers = await docker.listContainers({all:true, filters: {label: ['gs_manager=1']}});
    const servers = await Promise.all(containers.map(async c => {
      const container = docker.getContainer(c.Id);
      const s = await containerToServer(container);
      try{
        const info = await container.inspect();
        const ports = info.NetworkSettings && info.NetworkSettings.Ports ? info.NetworkSettings.Ports : {};
        for(const key of Object.keys(ports)){
          const binding = ports[key] && ports[key][0];
          if(binding && binding.HostPort){ s.hostPort = binding.HostPort; break }
        }
        // fallback: check label stored at creation time
        if(!s.hostPort && info.Config && info.Config.Labels && info.Config.Labels.gs_host_port){ s.hostPort = info.Config.Labels.gs_host_port }
      }catch(e){}
      return s;
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
  const { name, image, template } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try{
    let tpl = null;
    if(template && TEMPLATES[template]) tpl = TEMPLATES[template];
    const img = tpl ? tpl.image : image;
    if(!img) return res.status(400).json({ error: 'image required' });

    // template heuristics: if image looks like minecraft, expose 25565, else no host binding
    const isMinecraft = (tpl && tpl.id==='minecraft') || img.toLowerCase().includes('minecraft') || img.toLowerCase().includes('itzg/minecraft');
    const opts = {
      Image: img,
      name: name,
      Labels: { gs_manager: '1' },
      HostConfig: {
        RestartPolicy: { Name: 'no' },
        Binds: [`/opt/games/${name}:/data`]
      }
    };
    if(isMinecraft){
      // allow client to request a specific port
      let hostPort = req.body.port ? String(req.body.port) : await findFreePort(25565);
      // basic validation
      if(isNaN(parseInt(hostPort)) || parseInt(hostPort) < 1024 || parseInt(hostPort) > 65535) return res.status(400).json({ error: 'invalid port' });
      opts.Env = opts.Env || [];
      // default EULA and memory if not set, or from template
      const tplEnv = (tpl && tpl.env) ? tpl.env : {};
      Object.entries(tplEnv).forEach(([k,v])=>{ if(!opts.Env.some(e=>e.startsWith(k+'='))) opts.Env.push(`${k}=${v}`) });
      if(!opts.Env.some(e=>e.startsWith('EULA='))) opts.Env.push('EULA=TRUE');
      if(!opts.Env.some(e=>e.startsWith('MEMORY='))) opts.Env.push('MEMORY=1G');
      opts.ExposedPorts = { '25565/tcp': {} };
      opts.HostConfig.PortBindings = { '25565/tcp': [{ HostPort: hostPort }] };
      opts._hostPort = hostPort; // for response
      // record chosen host port in labels so we can show it even if container not running
      opts.Labels = opts.Labels || {};
      opts.Labels.gs_host_port = String(hostPort);
    } else if(tpl && tpl.ports && tpl.ports.length){
      // map template ports to available host ports sequentially
      opts.ExposedPorts = {};
      opts.HostConfig.PortBindings = {};
      for(const p of tpl.ports){
        const hostPort = await findFreePort(p);
        opts.ExposedPorts[`${p}/tcp`] = {};
        opts.HostConfig.PortBindings[`${p}/tcp`] = [{ HostPort: String(hostPort) }];
      }
    }
    const container = await docker.createContainer(opts);
    await container.start();
    res.json({ id: container.id, hostPort: opts._hostPort });
  }catch(err){
    res.status(500).json({ error: err.message });
  }
});

// Update port: recreate container with same data volume and new host port
app.post('/servers/:name/port', async (req,res)=>{
  const name = req.params.name; const { port } = req.body;
  if(!port) return res.status(400).json({ error: 'port required' });
  try{
    const containers = await docker.listContainers({all:true, filters:{name:[name]}});
    if(!containers.length) return res.status(404).json({ error: 'not found' });
    const old = containers[0];
    const info = await docker.getContainer(old.Id).inspect();
    // stop and remove
    try{ await docker.getContainer(old.Id).stop(); }catch(e){}
    await docker.getContainer(old.Id).remove({force:true});
    // recreate with same image and binds
    const opts = {
      Image: info.Config.Image,
      name: name,
      Labels: { gs_manager: '1' },
      HostConfig: { RestartPolicy:{Name:'no'}, Binds: info.HostConfig.Binds || [] }
    };
    // assume minecraft
    opts.Env = info.Config.Env || [];
    opts.ExposedPorts = { '25565/tcp': {} };
    opts.HostConfig.PortBindings = { '25565/tcp': [{ HostPort: String(port) }] };
    const c = await docker.createContainer(opts);
    await c.start();
    res.json({ result:'ok', hostPort: String(port) });
  }catch(err){ res.status(500).json({ error: err.message }); }
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
        try{
          const text = chunk.toString();
          // send in safe-sized chunks to avoid ws library limit
          const max = 120;
          for(let i=0;i<text.length;i+=max){ ws.send(text.slice(i,i+max)); }
        }catch(e){}
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
