import { useEffect, useState, type ReactNode, type FormEvent } from 'react';
import { ArrowRight, Check, Copy, Link2, Monitor, Plus, Smartphone, X } from 'lucide-react';
import { CONNECTION_EVENT, getToken, request, setToken } from '../api';
import { consumePairingFragment } from '../lib/pairing-fragment';
import './device-connection.css';

const initialSecret = consumePairingFragment(window.location, window.history);
type Device = { id: string; inviteId?: string; deviceName: string; clientType: string; createdAt: string; lastSeenAt?: string; revokedAt?: string };
type Invite = { inviteId: string; code: string; qrSecret: string; expiresAt: string };
export type ClientIdentity = { role: 'owner' | 'client'; deviceId?: string; deviceName?: string };
export const readClientIdentity = () => request<ClientIdentity>('/api/pairing/session/me');

export function DeviceConnectionGate({children}: {children: ReactNode}) {
  const [connected, setConnected] = useState(() => Boolean(getToken()));
  const [pairing, setPairing] = useState(initialSecret !== undefined);
  const [code, setCode] = useState('');
  const [name, setName] = useState('My browser');
  const [ownerToken, setOwnerToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const changed = () => setConnected(Boolean(getToken()));
    window.addEventListener(CONNECTION_EVENT, changed);
    window.addEventListener('storage', changed);
    return () => {window.removeEventListener(CONNECTION_EVENT, changed);window.removeEventListener('storage', changed);};
  }, []);
  if (connected && !pairing) return <>{children}</>;
  const redeem = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      // Pairing is public and deliberately never sends an existing owner credential.
      const response = await fetch(`${import.meta.env.VITE_API_BASE ?? ''}/api/pairing/redeem`, {
        method:'POST', headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(15_000),
        body:JSON.stringify({...(initialSecret ? {secret:initialSecret} : {code}),deviceName:name.trim(),clientType:'web'}),
      });
      if (!response.ok) throw new Error(response.status === 429 ? 'Too many attempts. Wait a minute before trying again.' : 'This invitation is invalid, expired, or already used. Create a new one from your connected device.');
      const value = await response.json() as {deviceToken:string};
      if (!value.deviceToken) throw new Error('The server did not return a device connection.');
      setToken(value.deviceToken); setPairing(false); setConnected(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not connect.'); }
    finally {setBusy(false);}
  };
  return <main className="connection-page">
    <header><img src="/brand/opencode-bot-wordmark.png" alt="opencode bot" /></header>
    <section className="connection-card">
      <span className="connection-kicker">YOUR WORKSPACE, WITH YOU</span>
      <h1>A familiar place.<br />A new device.</h1>
      <p>Connect to your bots, conversations, and computer.</p>
      <div className="connection-address"><Link2 size={14}/><span>{location.host}</span></div>
      <form onSubmit={redeem}>
        {!initialSecret && <label>Pairing code<input autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} required value={code} onChange={e=>setCode(e.target.value)} placeholder="Enter the code from your other device" className="text-input pairing-code-input" /></label>}
        <label>Device name<input className="text-input" maxLength={80} required value={name} onChange={e=>setName(e.target.value)} autoComplete="off" /></label>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <button className="primary-btn" disabled={busy || (!initialSecret && !code.trim())}>{busy ? 'Connecting…' : 'Connect this device'}<ArrowRight size={15}/></button>
      </form>
      <p className="connection-help">On a connected device, open <strong>Settings → Devices → Pair a device</strong>. Each invitation works once.</p>
      {connected && pairing && <button className="soft-btn" onClick={()=>setPairing(false)}>Keep my current connection</button>}
      <details className="owner-connection"><summary>Connect with an owner token</summary>
        <form onSubmit={e=>{e.preventDefault();setToken(ownerToken);setPairing(false);setConnected(true);}}>
          <label>Owner token<input className="text-input" type="password" required value={ownerToken} onChange={e=>setOwnerToken(e.target.value)} autoComplete="off" /></label>
          <button className="soft-btn" disabled={!ownerToken.trim()}>Connect as owner</button>
        </form>
      </details>
    </section>
    <footer>Private by invitation. Hosted by you.</footer>
  </main>;
}

export function DeviceSettings() {
  const [devices,setDevices]=useState<Device[]>([]);
  const [invite,setInvite]=useState<Invite|null>(null);
  const [qr,setQr]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [now,setNow]=useState(Date.now());
  const load=async()=>setDevices((await request<{devices:Device[]}>('/api/pairing/devices')).devices);
  useEffect(()=>{void load().catch(e=>setError(e.message));},[]);
  useEffect(()=>{
    if(!invite)return;
    const timer=window.setInterval(()=>setNow(Date.now()),1000);
    const poll=window.setInterval(()=>{void load().catch(()=>{});},5000);
    return ()=>{window.clearInterval(timer);window.clearInterval(poll);};
  },[invite]);
  const link=invite ? `${location.origin}/#pair=${invite.qrSecret}` : '';
  useEffect(()=>{
    setQr('');if(!link)return;let active=true;
    void import('qrcode').then(m=>m.toDataURL(link,{width:232,margin:2,color:{dark:'#24251f',light:'#f4f0e6'}})).then(value=>active&&setQr(value)).catch(()=>setError('The QR code could not be generated. Use the pairing code instead.'));
    return ()=>{active=false;};
  },[link]);
  const act=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'Could not update devices.');}finally{setBusy(false);}};
  const cancel=async()=>{if(invite)await request(`/api/pairing/invites/${invite.inviteId}`,{method:'DELETE'});setInvite(null);};
  const create=()=>act(async()=>{await cancel();setInvite(await request<Invite>('/api/pairing/invites',{method:'POST',body:'{}'}));setNow(Date.now());});
  const remaining=invite?Math.max(0,Math.ceil((Date.parse(invite.expiresAt)-now)/1000)):0;
  const paired=invite&&devices.find(d=>!d.revokedAt&&d.inviteId===invite.inviteId);
  const copy=async(value:string)=>{try{await navigator.clipboard.writeText(value);setNotice('Copied.');}catch{setError('Clipboard unavailable. Select and copy the code below.');}};
  return <section className="device-settings">
    <div className="settings-section-head"><div><h3>Your devices</h3><p>Bring this workspace to another browser or client.</p></div><button className="primary-btn" onClick={create} disabled={busy}><Plus size={14}/>Pair a device</button></div>
    {error&&<p className="inline-error" role="alert">{error}</p>}
    {notice&&<p className="settings-notice" role="status">{notice}</p>}
    {invite&&<div className="pairing-invitation">
      <div className="pairing-invitation-head"><strong>{paired?'Device connected':remaining?'Scan to connect':'Invitation expired'}</strong><button className="icon-btn" aria-label="Cancel pairing invitation" onClick={()=>void act(cancel)} disabled={busy}><X size={16}/></button></div>
      {paired?<p className="paired-success"><Check size={18}/>{paired.deviceName} is ready.</p>:remaining>0?<div className="pairing-invitation-body">
        <div className="pairing-qr">{qr?<img src={qr} alt="Scan to pair a device" width={232} height={232}/>:<span>Preparing QR code…</span>}</div>
        <div><p>Scan with your phone, or open this workspace on another device and enter:</p><code className="pairing-code">{invite.code}</code><div className="settings-actions"><button className="soft-btn" onClick={()=>void copy(invite.code)}><Copy size={13}/>Copy code</button><button className="soft-btn" onClick={()=>void copy(link)}><Link2 size={13}/>Copy link</button></div><small>One use · expires in {Math.floor(remaining/60)}:{String(remaining%60).padStart(2,'0')}</small></div>
      </div>:<p>Create a new invitation when your other device is ready.</p>}
    </div>}
    <p className="device-trust-note">Pair only devices you trust. They can use your bots and their computer. Owner settings stay on this device.</p>
    <details className="agent-connection"><summary>Connect an external agent</summary>
      <p>Use a pairing code to give your agent its own revocable connection, then configure its MCP client with this endpoint and the returned bearer token.</p>
      <div className="settings-actions"><code>{location.origin}/api/mcp</code><button className="soft-btn" onClick={()=>void copy(`${location.origin}/api/mcp`)}><Copy size={13}/>Copy endpoint</button></div>
      <a href="https://github.com/pkyanam/opencode-bot/blob/main/docs/mcp.md" target="_blank" rel="noreferrer">Connection instructions ↗</a>
    </details>
    <div className="device-list">
      <div className="device-row"><Monitor size={18}/><div><strong>This browser</strong><span>Owner connection</span></div></div>
      {devices.filter(d=>!d.revokedAt).map(device=><div className="device-row" key={device.id}>{device.clientType==='web'?<Monitor size={18}/>:<Smartphone size={18}/>}<div><strong>{device.deviceName}</strong><span>{device.lastSeenAt?`Last active ${new Date(device.lastSeenAt).toLocaleString()}`:`Connected ${new Date(device.createdAt).toLocaleDateString()}`}</span></div><button className="soft-btn" disabled={busy} onClick={()=>void act(async()=>{await request(`/api/pairing/devices/${device.id}/revoke`,{method:'POST',body:'{}'});await load();})}>Revoke</button></div>)}
    </div>
  </section>;
}
