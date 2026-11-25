import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, AlignLeft, Archive, ArrowLeft, ArrowUpRight, Bold, CalendarClock, Check, ChevronDown, ChevronLeft,
  ChevronRight, CircleHelp, Clock3, FileUp, Filter, Inbox, Italic, LayoutDashboard, Link as LinkIcon, List, ListOrdered, LoaderCircle,
  LogOut, Mail, Menu, MoreHorizontal, Paperclip, Plus, Search, Send, ShieldCheck, Slack, Users,
  Underline, Workflow, X, Eye, EyeOff, Star, Trash2, Quote, Redo2, Undo2, RefreshCw,
} from 'lucide-react';
import { io } from 'socket.io-client';
import { z } from 'zod';
import { api } from './services/api';

type User = { id: string; name: string; email: string; avatar: string | null };
type Sender = { id: string; email: string; hourlyLimit: number; minDelaySeconds: number; createdAt?: string };
type Email = {
  id: string; recipient: string; subject: string; senderId: string; scheduledAt: string;
  sentAt?: string | null; status: 'scheduled' | 'processing' | 'sent' | 'failed' | 'cancelled';
  body?: string; errorMessage?: string | null; previewUrl?: string | null; providerMessageId?: string | null;
};
type QueueStats = { waiting: number; active: number; delayed: number; completed: number; failed: number };
type DashboardStats = { scheduled: number; sent: number; failed: number; total: number; slackConnected: boolean };

const PAGE_SIZE = 10;
const emptyStats: DashboardStats = { scheduled: 0, sent: 0, failed: 0, total: 0, slackConnected: false };
const emptyQueue: QueueStats = { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 };

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [tab, setTab] = useState<'scheduled' | 'sent'>('scheduled');
  const [activePage, setActivePage] = useState<'overview' | 'scheduled' | 'sent'>('scheduled');
  const [items, setItems] = useState<Email[]>([]);
  const [total, setTotal] = useState(0);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [stats, setStats] = useState<DashboardStats>(emptyStats);
  const [queue, setQueue] = useState<QueueStats>(emptyQueue);
  const [queueLoaded, setQueueLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [senderModalOpen, setSenderModalOpen] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [details, setDetails] = useState<Email | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<Email | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; kind: 'success' | 'error' } | null>(null);

  const notify = (message: string, kind: 'success' | 'error' = 'success') => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(current => current?.message === message ? null : current), 4200);
  };

  async function refresh(quiet = false) {
    if (!user) return;
    if (!quiet) setLoading(true);
    try {
      const [list, dashboard, senderList, queueStats] = await Promise.all([
        api.get(`/emails/${tab}`, { params: { page, limit: PAGE_SIZE } }),
        api.get('/dashboard/stats'),
        api.get('/senders'),
        api.get('/queue'),
      ]);
      setItems(list.data.items || []);
      setTotal(Number(list.data.total || 0));
      setStats(dashboard.data);
      setSenders(senderList.data.items || []);
      setQueue(queueStats.data.queues || emptyQueue);
      setQueueLoaded(true);
    } catch (error: any) {
      notify(error.response?.data?.error || 'Could not load your dashboard. Try refreshing.', 'error');
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  useEffect(() => {
    let mounted = true;
    api.get('/auth/me')
      .then(response => { if (mounted) setUser(response.data.user); })
      .catch(() => { if (mounted) setUser(null); })
      .finally(() => { if (mounted) setAuthLoading(false); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!user) return;
    void refresh();
    const socket = io(import.meta.env.VITE_SERVER_URL || 'http://localhost:4000', { withCredentials: true });
    socket.on('email:updated', () => void refresh(true));
    const timer = window.setInterval(() => void refresh(true), 30_000);
    return () => { socket.disconnect(); window.clearInterval(timer); };
  }, [user, tab, page]);

  useEffect(() => {
    const handleUnauthorized = () => setUser(null);
    window.addEventListener('reachinbox:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('reachinbox:unauthorized', handleUnauthorized);
  }, []);

  const connectSlack = () => {
    window.location.href = `${import.meta.env.VITE_API_URL || 'http://localhost:4000/api'}/slack/connect`;
  };

  async function disconnectSlack() {
    try {
      await api.delete('/slack/disconnect');
      setIntegrationsOpen(false);
      notify('Slack disconnected');
      await refresh(true);
    } catch (error: any) {
      notify(error.response?.data?.error || 'Could not disconnect Slack.', 'error');
    }
  }

  async function logout() {
    try {
      await api.post('/auth/logout');
      setUser(null);
    } catch (error: any) {
      notify(error.response?.data?.error || 'Could not log out.', 'error');
    }
  }

  async function addSender(input: { email: string; smtpConfig: Record<string, unknown> }) {
    setBusy(true);
    try {
      await api.post('/senders', input);
      setSenderModalOpen(false);
      notify('Sender added successfully');
      await refresh(true);
    } catch (error: any) {
      notify(error.response?.data?.error || 'Could not add sender.', 'error');
      throw error;
    } finally { setBusy(false); }
  }

  async function updateSender(id: string, values: { hourlyLimit: number; minDelaySeconds: number }) {
    setBusy(true);
    try {
      await api.patch(`/senders/${id}`, values);
      notify('Sender settings saved');
      await refresh(true);
    } catch (error: any) {
      notify(error.response?.data?.error || 'Could not update sender settings.', 'error');
      throw error;
    } finally { setBusy(false); }
  }

  async function scheduleEmail(payload: {
    senderId: string; subject: string; body: string; recipients: string[]; startAt: string; delaySeconds: number;
  }) {
    setBusy(true);
    try {
      const idempotencyKey = crypto.randomUUID();
      const response = await api.post('/emails/schedule', {
        ...payload,
        startAt: new Date(payload.startAt).toISOString(),
        idempotencyKey,
      });
      setComposeOpen(false);
      setTab('scheduled');
      setActivePage('scheduled');
      setPage(1);
      notify(`Scheduled ${response.data.created} email${response.data.created === 1 ? '' : 's'}`);
      await refresh(true);
    } catch (error: any) {
      notify(error.response?.data?.error || 'Could not schedule emails.', 'error');
      throw error;
    } finally { setBusy(false); }
  }

  async function openDetails(email: Email) {
    setDetailsLoading(true);
    setDetails(email);
    try {
      const response = await api.get(`/emails/${email.id}`);
      setDetails(response.data.item);
    } catch (error: any) {
      notify(error.response?.data?.error || 'Could not load email details.', 'error');
    } finally { setDetailsLoading(false); }
  }

  async function cancelEmail() {
    if (!cancelTarget) return;
    setCancelBusy(true);
    try {
      await api.post(`/emails/${cancelTarget.id}/cancel`);
      setCancelTarget(null);
      notify('Scheduled email cancelled');
      await refresh(true);
    } catch (error: any) {
      notify(error.response?.data?.error || 'Could not cancel this email.', 'error');
    } finally { setCancelBusy(false); }
  }

  const visible = useMemo(() => items.filter(email => {
    const matchesSearch = !search || `${email.recipient} ${email.subject}`.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'all' || email.status === statusFilter;
    return matchesSearch && matchesStatus;
  }), [items, search, statusFilter]);

  if (authLoading) return <div className="auth-loading"><div className="brand-mark"><Mail size={20}/></div><span className="loader-line"/></div>;
  if (!user) return <LoginScreen />;

  const pageTitle = activePage === 'overview' ? 'Overview' : activePage === 'sent' ? 'Sent' : 'Scheduled';
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const scheduledCount = queue.waiting + queue.delayed;

  return (
    <div className="app-shell">
      {mobileNavOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}
      <Sidebar
        user={user} activePage={activePage} scheduledCount={stats.scheduled} sentCount={stats.sent} slackConnected={stats.slackConnected}
        mobileOpen={mobileNavOpen} onClose={() => setMobileNavOpen(false)}
        onNavigate={next => { setActivePage(next); setTab(next === 'sent' ? 'sent' : 'scheduled'); setPage(1); setStatusFilter('all'); setMobileNavOpen(false); }}
        onCompose={() => { setComposeOpen(true); setMobileNavOpen(false); }}
        onSenders={() => { setSenderModalOpen(true); setMobileNavOpen(false); }}
        onIntegrations={() => { setIntegrationsOpen(true); setMobileNavOpen(false); }}
        onLogout={logout}
      />

      <main className="main-panel">
        <header className="topbar inbox-topbar">
          <button className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu size={19}/></button>
          <label className="search-field inbox-search"><Search size={16}/><span className="sr-only">Search emails</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search" /></label>
          <label className="inbox-filter" title="Filter status"><Filter size={16}/><span className="sr-only">Filter by status</span><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">All statuses</option>{(tab === 'scheduled' ? ['scheduled', 'processing'] : ['sent', 'failed']).map(status => <option key={status} value={status}>{capitalize(status)}</option>)}</select></label>
          <button className="inbox-refresh" aria-label="Refresh emails" onClick={() => void refresh()}><RefreshCw size={21}/></button>
        </header>

        <div className="content-area">
          {activePage === 'overview' ? (
            <>
              <section className="welcome-row">
                <div>
                  <div className="eyebrow">{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())}</div>
                  <h1>Good to see you, {user.name.split(' ')[0]} <span className="welcome-spark">✳</span></h1>
                  <p>Here’s the latest on your email activity.</p>
                </div>
                <Button variant="primary" onClick={() => setComposeOpen(true)}><Plus size={17}/>Compose email</Button>
              </section>
              <section className="stats-grid" aria-label="Email statistics">
                <StatCard icon={<CalendarClock/>} label="Scheduled" value={stats.scheduled} detail="Emails queued to send" tone="green" onClick={() => { setTab('scheduled'); setActivePage('scheduled'); }} />
                <StatCard icon={<Send/>} label="Sent" value={stats.sent} detail="Accepted by your SMTP provider" tone="blue" onClick={() => { setTab('sent'); setActivePage('sent'); }} />
                <StatCard icon={<Activity/>} label="Failed" value={stats.failed} detail="Emails needing attention" tone="rose" />
                <StatCard icon={<Workflow/>} label="In queue" value={scheduledCount} detail={`${queue.active} currently processing`} tone="violet" />
              </section>
            </>
          ) : (
            <PageHeader
              eyebrow={activePage === 'sent' ? 'DELIVERY HISTORY' : 'UPCOMING SENDS'}
              title={activePage === 'sent' ? 'Sent emails' : 'Scheduled emails'}
              description={activePage === 'sent' ? 'Review messages accepted by your SMTP provider.' : 'Manage messages queued for a future send.'}
              action={<Button variant="primary" onClick={() => setComposeOpen(true)}><Plus size={16}/>Compose email</Button>}
            />
          )}

          <section className="section-heading">
            <div><h2>{activePage === 'overview' ? 'Email activity' : pageTitle}</h2><p>{activePage === 'overview' ? 'Track scheduled and sent messages in one place.' : `Browse ${activePage === 'sent' ? 'your sent email history' : 'emails waiting to send'}.`}</p></div>
            <Button variant="secondary" size="small" onClick={() => void refresh()}><Activity size={15}/>Refresh</Button>
          </section>

          <section className="data-card">
            <div className="table-toolbar">
              <div className="table-tabs" role="tablist" aria-label="Email status">
                <button role="tab" aria-selected={tab === 'scheduled'} className={tab === 'scheduled' ? 'selected' : ''} onClick={() => { setTab('scheduled'); setActivePage('scheduled'); setPage(1); setStatusFilter('all'); }}>
                  Scheduled <span className="tab-count">{stats.scheduled}</span>
                </button>
                <button role="tab" aria-selected={tab === 'sent'} className={tab === 'sent' ? 'selected' : ''} onClick={() => { setTab('sent'); setActivePage('sent'); setPage(1); setStatusFilter('all'); }}>Sent emails</button>
              </div>
              <div className="table-controls">
                <label className="search-field"><Search size={15}/><span className="sr-only">Search emails</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search recipient or subject" /></label>
                <label className="filter-select"><Filter size={15}/><span className="sr-only">Filter by status</span><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
                  <option value="all">All statuses</option>
                  {(tab === 'scheduled' ? ['scheduled', 'processing'] : ['sent', 'failed']).map(status => <option key={status} value={status}>{capitalize(status)}</option>)}
                </select><ChevronDown size={13}/></label>
              </div>
            </div>

            <div className="table-scroll">
              <table className="email-table">
                <thead><tr><th>RECIPIENT</th><th>SUBJECT</th><th>SENDER</th><th>{tab === 'scheduled' ? 'SCHEDULED FOR' : 'SENT AT'}</th><th>STATUS</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {loading ? <TableSkeleton /> : visible.length ? visible.map(email => {
                    const sender = senders.find(item => item.id === email.senderId);
                    return <tr key={email.id} className="email-row-clickable" tabIndex={0} aria-label={`Open email to ${email.recipient}: ${email.subject}`} onClick={() => void openDetails(email)} onKeyDown={event => { if(event.target===event.currentTarget&&(event.key==='Enter'||event.key===' ')){event.preventDefault();void openDetails(email)} }}>
                      <td><div className="recipient-cell"><span className="recipient-avatar">{email.recipient.slice(0, 1).toUpperCase()}</span><span className="recipient-text">{email.recipient}</span></div></td>
                      <td><span className="subject-text" title={email.subject}>{email.subject}</span><span className="inbox-preview">— {email.body?.replace(/\s+/g, ' ').slice(0, 100) || 'Open to view message details'}</span></td>
                      <td><span className="sender-text">{sender?.email || '—'}</span></td>
                      <td><div className="date-cell"><span>{formatDate(tab === 'scheduled' ? email.scheduledAt : email.sentAt || email.scheduledAt)}</span><small>{formatTime(tab === 'scheduled' ? email.scheduledAt : email.sentAt || email.scheduledAt)}</small></div></td>
                      <td><StatusBadge status={email.status}/></td>
                      <td><div className="row-actions" onClick={event=>event.stopPropagation()}>
                        <IconButton label="View email details" onClick={() => void openDetails(email)}><Star size={15}/></IconButton>
                        {tab === 'scheduled' && email.status === 'scheduled' && <IconButton label="Cancel scheduled email" onClick={() => setCancelTarget(email)}><MoreHorizontal size={17}/></IconButton>}
                      </div></td>
                    </tr>;
                  }) : <tr><td colSpan={6}><EmptyState
                    icon={<Inbox size={21}/>} title={search || statusFilter !== 'all' ? 'No matching emails' : `No ${tab} emails yet`}
                    description={search || statusFilter !== 'all' ? 'Try adjusting your search or status filter.' : 'Once you schedule an email, it will appear here.'}
                    action={!search && statusFilter === 'all' && <Button variant="secondary" size="small" onClick={() => setComposeOpen(true)}><Plus size={15}/>Compose your first email</Button>}
                  /></td></tr>}
                </tbody>
              </table>
            </div>

            <div className="table-footer">
              <span>Showing <strong>{total ? (page - 1) * PAGE_SIZE + 1 : 0}–{Math.min(page * PAGE_SIZE, total)}</strong> of <strong>{total}</strong> emails</span>
              <div className="pagination"><button aria-label="Previous page" disabled={page <= 1 || loading} onClick={() => setPage(value => Math.max(1, value - 1))}><ChevronLeft size={16}/></button><span>Page {page} of {totalPages}</span><button aria-label="Next page" disabled={page >= totalPages || loading} onClick={() => setPage(value => Math.min(totalPages, value + 1))}><ChevronRight size={16}/></button></div>
            </div>
          </section>

          {activePage === 'overview' && <section className="overview-bottom">
            <div className="integration-card">
              <div className="integration-icon slack-icon"><Slack size={19}/></div>
              <div className="integration-copy"><span className="eyebrow">INTEGRATION</span><h3>{stats.slackConnected ? 'Slack is connected' : 'Bring notifications to Slack'}</h3><p>Get a heads-up when a sender reaches its hourly limit.</p></div>
              <Button variant="secondary" size="small" onClick={() => stats.slackConnected ? void disconnectSlack() : connectSlack()}>{stats.slackConnected ? 'Disconnect' : 'Connect Slack'}<ArrowUpRight size={14}/></Button>
            </div>
            <div className="queue-card">
              <div className="queue-card-heading"><div><span className="eyebrow">DELIVERY</span><h3>Queue activity</h3></div><span className={`queue-health ${queueLoaded ? 'ready' : ''}`}><i/>{queueLoaded ? queue.failed ? `${queue.failed} failed` : 'Connected' : 'Loading'}</span></div>
              <div className="queue-metrics"><div><strong>{queue.waiting + queue.delayed}</strong><span>Waiting</span></div><div><strong>{queue.active}</strong><span>Processing</span></div><div><strong>{queue.completed}</strong><span>Completed</span></div></div>
              <div className="queue-meter" aria-label={`${queue.active} jobs active`}><span style={{ width: `${Math.min(100, queue.active ? Math.max(8, queue.active / Math.max(1, queue.active + queue.waiting + queue.delayed) * 100) : 0)}%` }}/></div>
            </div>
          </section>}
          <footer className="page-footer"><span>ReachInbox <span className="footer-dot">·</span> Email scheduling</span><span><CircleHelp size={13}/> Your SMTP provider controls final delivery.</span></footer>
        </div>
      </main>

      {composeOpen && <ComposeModal senders={senders} initialSenderId={senders[0]?.id || ''} busy={busy} onClose={() => setComposeOpen(false)} onAddSender={() => { setComposeOpen(false); setSenderModalOpen(true); }} onSubmit={scheduleEmail}/>}
      {senderModalOpen && <SenderManagementModal senders={senders} busy={busy} onClose={() => setSenderModalOpen(false)} onAdd={addSender} onUpdate={updateSender}/>}
      {integrationsOpen && <IntegrationsModal user={user} slackConnected={stats.slackConnected} senderCount={senders.length} onClose={() => setIntegrationsOpen(false)} onConnectSlack={connectSlack} onDisconnectSlack={disconnectSlack} onManageSenders={() => { setIntegrationsOpen(false); setSenderModalOpen(true); }}/ >}
      {details && <EmailDetailsModal email={details} loading={detailsLoading} sender={senders.find(item => item.id === details.senderId)} user={user} onClose={() => setDetails(null)}/>}
      {cancelTarget && <Modal title="Cancel scheduled email?" eyebrow="CONFIRM ACTION" onClose={() => setCancelTarget(null)} size="small">
        <p className="confirm-copy">This email to <strong>{cancelTarget.recipient}</strong> will be removed from the scheduled queue.</p>
        <div className="modal-actions"><Button variant="secondary" onClick={() => setCancelTarget(null)}>Keep email</Button><Button variant="danger" disabled={cancelBusy} onClick={() => void cancelEmail()}>{cancelBusy ? <LoaderCircle size={15} className="spin"/> : null}Cancel email</Button></div>
      </Modal>}
      {toast && <div className={`toast toast-${toast.kind}`} role="status"><span className="toast-icon">{toast.kind === 'success' ? <Check size={16}/> : <X size={16}/>}</span><span>{toast.message}</span><button aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={15}/></button></div>}
    </div>
  );
}

function Sidebar({user,activePage,scheduledCount,sentCount,slackConnected,mobileOpen,onClose,onNavigate,onCompose,onSenders,onIntegrations,onLogout}:{user:User;activePage:string;scheduledCount:number;sentCount:number;slackConnected:boolean;mobileOpen:boolean;onClose:()=>void;onNavigate:(page:'overview'|'scheduled'|'sent')=>void;onCompose:()=>void;onSenders:()=>void;onIntegrations:()=>void;onLogout:()=>void}) {
  const [accountMenuOpen,setAccountMenuOpen]=useState(false);
  return <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
    <div className="sidebar-brand"><span className="inbox-logo">ONB</span><button className="sidebar-close icon-button" aria-label="Close navigation" onClick={onClose}><X size={18}/></button></div>
    <button className="workspace-switcher" onClick={()=>setAccountMenuOpen(value=>!value)} aria-expanded={accountMenuOpen}><Avatar user={user}/><span className="workspace-info"><strong>{user.name}</strong><span>{user.email}</span></span><ChevronDown size={15}/></button>
    {accountMenuOpen&&<div className="account-menu"><button onClick={()=>{setAccountMenuOpen(false);onSenders()}}>Manage senders</button><button onClick={()=>{setAccountMenuOpen(false);onIntegrations()}}>Integrations{slackConnected?' · connected':''}</button><button onClick={()=>void onLogout()}>Log out</button></div>}
    <button className="inbox-compose" onClick={onCompose}>Compose</button>
    <div className="sidebar-label">CORE</div>
    <nav className="primary-nav" aria-label="Main navigation">
      <button className={`nav-item ${activePage !== 'sent' ? 'active' : ''}`} onClick={() => onNavigate('scheduled')}><CalendarClock size={16}/><span>Scheduled</span><span className="nav-count">{scheduledCount}</span></button>
      <button className={`nav-item ${activePage === 'sent' ? 'active' : ''}`} onClick={() => onNavigate('sent')}><Send size={16}/><span>Sent</span><span className="nav-count nav-count-sent">{sentCount}</span></button>
    </nav>
    <div className="sidebar-label sidebar-label-spaced">MANAGE</div>
    <nav className="secondary-nav" aria-label="Management">
      <button className="nav-item" onClick={onSenders}><Users size={17}/><span>Senders</span></button>
      <button className="nav-item" onClick={onIntegrations}><Workflow size={17}/><span>Integrations</span><span className={`nav-dot ${slackConnected ? 'connected' : ''}`}/></button>
    </nav>
    <div className="sidebar-bottom">
      <div className="sidebar-help"><div className="help-symbol"><ShieldCheck size={16}/></div><div><strong>Sending, made simple</strong><span>Track your outreach in one place.</span></div></div>
      <div className="profile-row"><Avatar user={user}/><div className="profile-copy"><strong>{user.name}</strong><span>{user.email}</span></div><IconButton label="Log out" onClick={onLogout}><LogOut size={16}/></IconButton></div>
    </div>
  </aside>;
}

function LoginScreen() {
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [showPassword,setShowPassword]=useState(false);
  const [error,setError]=useState(new URLSearchParams(window.location.search).get('auth')==='failed'?'Google sign-in was unsuccessful. Please try again.':'');
  function submit(event:FormEvent){
    event.preventDefault();
    const result=z.object({email:z.string().email('Enter a valid email address.'),password:z.string().min(1,'Enter your password.')}).safeParse({email,password});
    if(!result.success){setError(result.error.issues[0]?.message||'Check your email and password.');return}
    setError('Email and password sign-in is not configured for this project. Please use Google login.');
  }
  return <main className="login-screen"><section className="login-card" aria-labelledby="login-heading">
    <h1 id="login-heading">Login</h1>
    <a className="login-google" href={`${import.meta.env.VITE_API_URL || 'http://localhost:4000/api'}/auth/google`}><GoogleGlyph/><span>Login with Google</span></a>
    <div className="login-divider"><span>or sign up through email</span></div>
    <form className="login-form" onSubmit={submit} noValidate>
      <label className="sr-only" htmlFor="login-email">Email ID</label>
      <input id="login-email" type="email" autoComplete="username" placeholder="Email ID" value={email} onChange={event=>setEmail(event.target.value)} aria-invalid={!!error} />
      <label className="sr-only" htmlFor="login-password">Password</label>
      <div className="login-password-field"><input id="login-password" type={showPassword?'text':'password'} autoComplete="current-password" placeholder="Password" value={password} onChange={event=>setPassword(event.target.value)} aria-invalid={!!error}/><button type="button" className="password-toggle" aria-label={showPassword?'Hide password':'Show password'} onClick={()=>setShowPassword(value=>!value)}>{showPassword?<EyeOff size={15}/>:<Eye size={15}/>}</button></div>
      {error&&<p className="login-error" role="alert">{error}</p>}
      <button className="login-submit" type="submit">Login</button>
    </form>
  </section></main>;
}

function GoogleGlyph(){return <svg aria-hidden="true" viewBox="0 0 48 48" width="18" height="18"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.89c-.58 2.96-2.26 5.48-4.73 7.18l7.31 5.67c4.27-3.94 6.75-9.75 6.75-17.32Z"/><path fill="#FBBC05" d="M10.54 28.59a14.5 14.5 0 0 1 0-9.18l-7.98-6.19a24 24 0 0 0 0 21.56l7.98-6.19Z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.9-5.8l-7.31-5.67c-2.03 1.36-4.62 2.17-8.59 2.17-6.26 0-11.57-4.22-13.46-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"/></svg>}

function Button({children,onClick,variant='secondary',size='medium',disabled,type='button',className='',title}:{children:ReactNode;onClick?:()=>void;variant?:'primary'|'secondary'|'ghost'|'danger';size?:'small'|'medium';disabled?:boolean;type?:'button'|'submit';className?:string;title?:string}) {
  return <button type={type} title={title} disabled={disabled} onClick={onClick} className={`button button-${variant} button-${size} ${className}`}>{children}</button>;
}
function IconButton({children,onClick,label,disabled=false}:{children:ReactNode;onClick:()=>void;label:string;disabled?:boolean}){return <button type="button" className="icon-button" aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</button>}
function Avatar({user,size='normal'}:{user:User;size?:'normal'|'small'}){return user.avatar?<img className={`avatar avatar-${size}`} src={user.avatar} alt=""/>:<span className={`avatar avatar-fallback avatar-${size}`} aria-hidden="true">{initials(user.name)}</span>}
function StatCard({icon,label,value,detail,tone,onClick}:{icon:ReactNode;label:string;value:number;detail:string;tone:string;onClick?:()=>void}){return <button type="button" className={`stat-card ${onClick?'stat-card-clickable':''}`} onClick={onClick} disabled={!onClick}><div className={`stat-icon ${tone}`}>{icon}</div><span className="stat-title">{label}</span><strong>{value.toLocaleString()}</strong><span className="stat-detail">{detail}</span>{onClick&&<ArrowUpRight className="stat-arrow" size={15}/>}</button>}
function PageHeader({eyebrow,title,description,action}:{eyebrow:string;title:string;description:string;action:ReactNode}){return <section className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</section>}
function StatusBadge({status}:{status:string}){return <span className={`status-badge status-${status}`}><i/>{capitalize(status)}</span>}
function EmptyState({icon,title,description,action}:{icon:ReactNode;title:string;description:string;action?:ReactNode}){return <div className="empty-state"><div className="empty-icon">{icon}</div><strong>{title}</strong><p>{description}</p>{action}</div>}
function TableSkeleton(){return <>{Array.from({length:5},(_,index)=><tr className="skeleton-row" key={index}><td><span className="skeleton skeleton-recipient"/></td><td><span className="skeleton skeleton-subject"/></td><td><span className="skeleton skeleton-sender"/></td><td><span className="skeleton skeleton-date"/></td><td><span className="skeleton skeleton-status"/></td><td/></tr>)}</>}

function Modal({children,title,eyebrow,onClose,size='medium'}:{children:ReactNode;title:string;eyebrow?:string;onClose:()=>void;size?:'small'|'medium'|'large'}) {
  useEffect(()=>{const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')onClose()};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey)},[onClose]);
  return <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><section className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><div>{eyebrow&&<span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div><IconButton label="Close dialog" onClick={onClose}><X size={18}/></IconButton></header>{children}</section></div>;
}

function ComposeModal({senders,initialSenderId,busy,onClose,onAddSender,onSubmit}:{senders:Sender[];initialSenderId:string;busy:boolean;onClose:()=>void;onAddSender:()=>void;onSubmit:(payload:{senderId:string;subject:string;body:string;recipients:string[];startAt:string;delaySeconds:number})=>Promise<void>}) {
  const [subject,setSubject]=useState('');
  const [body,setBody]=useState('');
  const [recipientText,setRecipientText]=useState('');
  const [recipientInput,setRecipientInput]=useState('');
  const [senderId,setSenderId]=useState(initialSenderId);
  const [startAt,setStartAt]=useState('');
  const [scheduleDraft,setScheduleDraft]=useState('');
  const [delaySeconds,setDelaySeconds]=useState(2);
  const [error,setError]=useState('');
  const [dragging,setDragging]=useState(false);
  const [scheduleOpen,setScheduleOpen]=useState(false);
  const [attachments,setAttachments]=useState<File[]>([]);
  const fileRef=useRef<HTMLInputElement>(null);
  const attachmentRef=useRef<HTMLInputElement>(null);
  const editorRef=useRef<HTMLDivElement>(null);
  const found=recipientText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[];
  const recipients=[...new Set(found.map(value=>value.trim().toLowerCase()))];
  const selected=senders.find(sender=>sender.id===senderId);
  function localDateTime(date:Date){return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16)}
  function suggestedTime(hour?:number){const date=new Date();date.setDate(date.getDate()+1);date.setHours(hour??9,0,0,0);return localDateTime(date)}
  function showSchedulePicker(){setScheduleDraft(startAt);setScheduleOpen(true)}
  function commitSchedule(){if(!scheduleDraft){setError('Choose a send date and time.');return}setStartAt(scheduleDraft);setScheduleOpen(false);setError('')}
  function cancelSchedule(){setScheduleDraft(startAt);setScheduleOpen(false);setError('')}
  async function readFile(file?:File){if(!file)return;try{setRecipientText(await file.text());setError('')}catch{setError('Could not read that file. Please try a CSV or TXT file.')}}
  function addRecipient(){const value=recipientInput.trim().replace(/[,;]+$/,'');if(value)setRecipientText(current=>(current?current+', ':'')+value);setRecipientInput('')}
  function removeRecipient(email:string){setRecipientText(recipients.filter(value=>value!==email).join(', '))}
  function format(command:string,value?:string){editorRef.current?.focus();document.execCommand(command,false,value);setBody(editorRef.current?.innerHTML||'')}
  async function submit(event:FormEvent){
    event.preventDefault();
    if(attachments.length){setError('Attachments are not supported by the current email scheduler yet. Remove the selected files to continue.');return}
    const bodyValue=editorRef.current?.innerHTML||body;
    const bodyText=editorRef.current?.innerText||body;
    const nextRecipients=[...new Set((recipientText+', '+recipientInput).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.map(value=>value.trim().toLowerCase())||[])];
    const parsed=z.object({subject:z.string().min(1,'Add a subject.'),body:z.string().min(1,'Write an email message.'),senderId:z.string().min(1,'Choose a sender.'),recipients:z.array(z.string().email()).min(1,'Add at least one valid email address.'),startAt:z.string().min(1,'Choose a send date and time.'),delaySeconds:z.number().int().min(0).max(3600)}).safeParse({subject,body:bodyText.trim()?bodyValue:'',senderId,recipients:nextRecipients,startAt,delaySeconds});
    if(!parsed.success){setError(parsed.error.issues[0]?.message||'Check the highlighted fields.');if(!startAt)showSchedulePicker();return}
    setError('');
    try{await onSubmit(parsed.data)}catch{}
  }
  return <form className="compose-page" onSubmit={submit} aria-busy={busy}>
    <header className="compose-page-header"><button type="button" className="compose-back" onClick={onClose} aria-label="Back to emails"><ArrowLeft size={20}/></button><h1>Compose New Email</h1><div className="compose-page-actions"><button type="button" className="compose-attach" aria-label="Add attachment" title="Add attachment" onClick={()=>attachmentRef.current?.click()}><Paperclip size={21}/>{attachments.length>0&&<span className="attachment-count">{attachments.length}</span>}</button><input ref={attachmentRef} className="sr-only" type="file" multiple onChange={event=>{const files=Array.from(event.target.files||[]);setAttachments(current=>[...current,...files]);event.target.value=''}}/><button type="button" className="compose-clock" aria-label="Set send time" title="Set send time" onClick={()=>scheduleOpen?cancelSchedule():showSchedulePicker()}><Clock3 size={19}/></button><button className="send-later" type="submit" disabled={busy||!senders.length}>{busy?<LoaderCircle size={14} className="spin"/>:'Send'}</button></div></header>
    <div className="compose-page-content">
      {attachments.length>0&&<div className="compose-attachments">{attachments.map((file,index)=><span className="compose-attachment" key={file.name+file.size+index} title={file.name}>{file.name}<button type="button" aria-label={'Remove '+file.name} onClick={()=>setAttachments(current=>current.filter((_,fileIndex)=>fileIndex!==index))}>×</button></span>)}</div>}
      <div className="compose-line"><label htmlFor="sender-select">From</label>{senders.length?<select id="sender-select" value={senderId} onChange={event=>setSenderId(event.target.value)} required><option value="">Select a sender</option>{senders.map(sender=><option key={sender.id} value={sender.id}>{sender.email}</option>)}</select>:<div className="no-senders"><span>No senders connected yet.</span><Button size="small" onClick={onAddSender}><Plus size={14}/>Add sender</Button></div>}</div>
      <div className={'compose-line compose-to'+(dragging?' is-dragging':'')} onDragOver={event=>{event.preventDefault();setDragging(true)}} onDragLeave={()=>setDragging(false)} onDrop={event=>{event.preventDefault();setDragging(false);void readFile(event.dataTransfer.files[0])}}>
        <label htmlFor="recipient-input">To</label><div className="recipient-chip-area">{recipients.slice(0,3).map(email=><button type="button" className="recipient-chip" key={email} onClick={()=>removeRecipient(email)} title={'Remove '+email}>{email}<span aria-hidden="true">x</span></button>)}{recipients.length>3&&<span className="recipient-chip recipient-more">+{recipients.length-3}</span>}<input id="recipient-input" value={recipientInput} onChange={event=>setRecipientInput(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'||event.key===','||event.key===' '){event.preventDefault();addRecipient()}}} onBlur={addRecipient} placeholder={recipients.length?'':'Add recipients'} /></div>
        <button type="button" className="upload-list" onClick={()=>fileRef.current?.click()}><FileUp size={14}/>Upload List</button><input ref={fileRef} className="sr-only" type="file" accept=".csv,.txt,text/plain,text/csv" onChange={event=>void readFile(event.target.files?.[0])}/>
      </div>
      <div className="compose-line compose-subject"><label htmlFor="email-subject">Subject</label><input id="email-subject" value={subject} onChange={event=>setSubject(event.target.value)} placeholder="Subject" maxLength={500}/></div>
      <div className="compose-page-options"><label><span>Delay between {recipients.length||2} emails</span><input aria-label="Delay between emails in seconds" type="number" min="0" max="3600" value={delaySeconds} onChange={event=>setDelaySeconds(Number(event.target.value))}/><small>sec</small></label><label><span>Hourly Limit</span><input aria-label="Sender hourly limit" type="number" value={selected?.hourlyLimit||0} readOnly/><small>emails</small></label></div>
      {scheduleOpen&&<div className="send-later-popover" role="dialog" aria-label="Schedule email">
        <h2>Send Later</h2>
        <label className="send-later-date"><span className="send-later-date-label">{scheduleDraft?new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(scheduleDraft)):'Pick date & time'}</span><input id="start-at" type="datetime-local" value={scheduleDraft} onChange={event=>setScheduleDraft(event.target.value)} aria-label="Pick date and time"/><CalendarClock size={18}/></label>
        <div className="send-later-presets"><button type="button" onClick={()=>setScheduleDraft(suggestedTime())}>Tomorrow</button><button type="button" onClick={()=>setScheduleDraft(suggestedTime(10))}>Tomorrow, 10:00 AM</button><button type="button" onClick={()=>setScheduleDraft(suggestedTime(11))}>Tomorrow, 11:00 AM</button><button type="button" onClick={()=>setScheduleDraft(suggestedTime(15))}>Tomorrow, 3:00 PM</button></div>
        {error&&<p className="send-later-error" role="alert">{error}</p>}
        <div className="send-later-actions"><button type="button" className="schedule-cancel" onClick={cancelSchedule}>Cancel</button><button type="button" className="schedule-done" onClick={commitSchedule}>Done</button></div>
      </div>}
      <section className="compose-editor" aria-label="Email body editor"><div className="compose-editor-toolbar" role="toolbar" aria-label="Message formatting">
        <button type="button" aria-label="Undo" onMouseDown={event=>event.preventDefault()} onClick={()=>format('undo')}><Undo2 size={15}/></button><button type="button" aria-label="Redo" onMouseDown={event=>event.preventDefault()} onClick={()=>format('redo')}><Redo2 size={15}/></button><span className="editor-tool-divider"/>
        <button type="button" aria-label="Align left" onMouseDown={event=>event.preventDefault()} onClick={()=>format('justifyLeft')}><AlignLeft size={15}/></button><button type="button" aria-label="Bold" onMouseDown={event=>event.preventDefault()} onClick={()=>format('bold')}><Bold size={15}/></button><button type="button" aria-label="Italic" onMouseDown={event=>event.preventDefault()} onClick={()=>format('italic')}><Italic size={15}/></button><button type="button" aria-label="Underline" onMouseDown={event=>event.preventDefault()} onClick={()=>format('underline')}><Underline size={15}/></button><span className="editor-tool-divider"/>
        <button type="button" aria-label="Numbered list" onMouseDown={event=>event.preventDefault()} onClick={()=>format('insertOrderedList')}><ListOrdered size={15}/></button><button type="button" aria-label="Bulleted list" onMouseDown={event=>event.preventDefault()} onClick={()=>format('insertUnorderedList')}><List size={15}/></button><button type="button" aria-label="Quote" onMouseDown={event=>event.preventDefault()} onClick={()=>format('formatBlock','blockquote')}><Quote size={15}/></button><button type="button" aria-label="Insert link" onMouseDown={event=>event.preventDefault()} onClick={()=>{const url=window.prompt('Enter a link URL');if(url)format('createLink',url)}}><LinkIcon size={15}/></button>
      </div><div ref={editorRef} className="compose-editor-input" contentEditable suppressContentEditableWarning role="textbox" aria-label="Email message" aria-multiline="true" data-placeholder="Type Your Email..." onInput={event=>setBody(event.currentTarget.innerHTML)}/></section>
      {error&&<div className="form-error compose-page-error" role="alert">{error}</div>}
      {selected&&<div className="compose-limit-note"><ShieldCheck size={14}/>{selected.minDelaySeconds}s minimum delay - sender limit {selected.hourlyLimit} emails per hour</div>}
    </div>
  </form>;
}

function SenderManagementModal({senders,busy,onClose,onAdd,onUpdate}:{senders:Sender[];busy:boolean;onClose:()=>void;onAdd:(input:{email:string;smtpConfig:Record<string,unknown>})=>Promise<void>;onUpdate:(id:string,values:{hourlyLimit:number;minDelaySeconds:number})=>Promise<void>}) {
  const [adding,setAdding]=useState(false);const[email,setEmail]=useState('');const[host,setHost]=useState('smtp.ethereal.email');const[port,setPort]=useState('587');const[smtpUser,setSmtpUser]=useState('');const[password,setPassword]=useState('');const[limits,setLimits]=useState<Record<string,{hourlyLimit:number;minDelaySeconds:number}>>({});const[formError,setFormError]=useState('');
  async function create(event:FormEvent){event.preventDefault();const parsed=z.object({email:z.string().email(),host:z.string().min(1),port:z.coerce.number().int().positive(),smtpUser:z.string(),password:z.string()}).safeParse({email,host,port,smtpUser,password});if(!parsed.success){setFormError(parsed.error.issues[0]?.message||'Check the sender details.');return}setFormError('');try{await onAdd({email:parsed.data.email,smtpConfig:{host:parsed.data.host,port:parsed.data.port,user:parsed.data.smtpUser||undefined,pass:parsed.data.password||undefined,secure:false}})}catch{}}
  async function save(sender:Sender){const value=limits[sender.id]||{hourlyLimit:sender.hourlyLimit,minDelaySeconds:sender.minDelaySeconds};if(value.hourlyLimit<1||value.minDelaySeconds<0){setFormError('Hourly limit must be at least 1 and delay cannot be negative.');return}setFormError('');try{await onUpdate(sender.id,value)}catch{}}
  return <Modal title="Sender accounts" eyebrow="DELIVERY SETTINGS" onClose={onClose} size="large">
    <div className="sender-modal-body">
      <div className="modal-section-heading"><div><h3>Your senders</h3><p>Manage the sending pace for each configured SMTP account.</p></div><Button size="small" variant={adding?'secondary':'primary'} onClick={()=>{setAdding(value=>!value);setFormError('')}}>{adding?<X size={14}/>:<Plus size={14}/>} {adding?'Close':'Add sender'}</Button></div>
      {senders.length===0&&!adding?<EmptyState icon={<Send size={20}/>} title="No senders connected" description="Add an SMTP sender to start scheduling emails." action={<Button variant="primary" size="small" onClick={()=>setAdding(true)}><Plus size={14}/>Add your first sender</Button>}/>:<div className="sender-list">{senders.map(sender=>{const value=limits[sender.id]||{hourlyLimit:sender.hourlyLimit,minDelaySeconds:sender.minDelaySeconds};return <article className="sender-card" key={sender.id}><div className="sender-card-top"><div className="sender-avatar"><Mail size={17}/></div><div className="sender-main"><strong>{sender.email}</strong><span>SMTP settings saved</span></div><span className="sender-configured"><i/>Configured</span></div><div className="sender-settings"><label>Hourly limit<input type="number" min="1" max="10000" value={value.hourlyLimit} onChange={event=>setLimits(current=>({...current,[sender.id]:{...value,hourlyLimit:Number(event.target.value)}}))}/></label><label>Minimum delay<input type="number" min="0" max="3600" value={value.minDelaySeconds} onChange={event=>setLimits(current=>({...current,[sender.id]:{...value,minDelaySeconds:Number(event.target.value)}}))}/></label><Button size="small" onClick={()=>void save(sender)} disabled={busy}><Check size={14}/>Save settings</Button></div></article>})}</div>}
      {adding&&<form className="sender-add-form" onSubmit={create}><div className="sender-form-title"><div><span className="eyebrow">NEW SMTP SENDER</span><h3>Connect a sender</h3></div></div><div className="sender-form-grid"><label>From email<input type="email" required value={email} onChange={event=>setEmail(event.target.value)} placeholder="you@example.com"/></label><label>SMTP host<input required value={host} onChange={event=>setHost(event.target.value)} placeholder="smtp.ethereal.email"/></label><label>SMTP port<input type="number" required value={port} onChange={event=>setPort(event.target.value)}/></label><label>SMTP username<input value={smtpUser} onChange={event=>setSmtpUser(event.target.value)} placeholder="Leave blank to use server credentials"/></label><label className="sender-password-field">SMTP password<input type="password" value={password} onChange={event=>setPassword(event.target.value)} placeholder="Leave blank to use server credentials"/><small>Stored encrypted. Passwords are never returned to the dashboard.</small></label></div>{formError&&<div className="form-error" role="alert">{formError}</div>}<div className="sender-form-actions"><span><ShieldCheck size={14}/> Credentials are protected</span><Button variant="primary" type="submit" disabled={busy}>{busy?<LoaderCircle className="spin" size={15}/>:<Plus size={15}/>}Add sender</Button></div></form>}
      {!formError&&<div className="sender-security-note"><InfoIcon/> Sender passwords are write-only. SMTP verification is performed when the worker sends a message.</div>}
      {formError&&!adding&&<div className="form-error" role="alert">{formError}</div>}
    </div>
  </Modal>;
}

function IntegrationsModal({user,slackConnected,senderCount,onClose,onConnectSlack,onDisconnectSlack,onManageSenders}:{user:User;slackConnected:boolean;senderCount:number;onClose:()=>void;onConnectSlack:()=>void;onDisconnectSlack:()=>void;onManageSenders:()=>void}){
  return <Modal title="Integrations" eyebrow="CONNECTED SERVICES" onClose={onClose} size="medium"><div className="integration-list">
    <article className="integration-row"><div className="integration-provider google-provider"><GoogleGlyph/></div><div className="integration-row-copy"><strong>Google account</strong><span>{user.email}</span></div><span className="integration-state connected"><i/>Connected</span></article>
    <article className="integration-row"><div className="integration-provider slack-provider"><Slack size={19}/></div><div className="integration-row-copy"><strong>Slack</strong><span>{slackConnected?'Hourly-limit notifications are enabled.':'Connect a workspace for sending alerts.'}</span></div>{slackConnected?<Button size="small" variant="secondary" onClick={onDisconnectSlack}>Disconnect</Button>:<Button size="small" variant="primary" onClick={onConnectSlack}>Connect Slack<ArrowUpRight size={14}/></Button>}</article>
    <article className="integration-row"><div className="integration-provider smtp-provider"><Send size={18}/></div><div className="integration-row-copy"><strong>SMTP delivery</strong><span>{senderCount ? `${senderCount} sender configuration${senderCount===1?'':'s'} saved` : 'No SMTP senders configured'}</span></div><Button size="small" variant="secondary" onClick={onManageSenders}>Manage senders<ChevronRight size={14}/></Button></article>
  </div><p className="integration-footnote"><ShieldCheck size={14}/> Connection details are shown from your current account and server configuration.</p></Modal>;
}

function EmailDetailsModal({email,loading,sender,user,onClose}:{email:Email;loading:boolean;sender?:Sender;user:User;onClose:()=>void}){
  const date = email.sentAt || email.scheduledAt;
  const senderEmail = sender?.email || 'Sender account';
  const senderName = senderEmail.split('@')[0].replace(/[._-]+/g,' ').replace(/\b\w/g,char=>char.toUpperCase());
  const messageBody = email.body || '';
  const hasHtml = /<[a-z][\s\S]*>/i.test(messageBody);
  return <main className="message-reader" aria-label="Email message">
    <header className="reader-toolbar">
      <button type="button" className="reader-back" onClick={onClose} aria-label="Back to emails"><ArrowLeft size={19}/></button>
      <h1 title={email.subject}>{email.subject}</h1>
      <div className="reader-toolbar-actions"><button type="button" className="reader-action" disabled aria-label="Star email" title="Starred email actions are not available"><Star size={17}/></button><button type="button" className="reader-action" disabled aria-label="Archive email" title="Archiving is not available"><Archive size={16}/></button><button type="button" className="reader-action" disabled aria-label="Delete email" title="Deleting is not available"><Trash2 size={16}/></button><span className="reader-action-divider"/><Avatar user={user} size="small"/></div>
    </header>
    <section className="reader-message">
      <div className="reader-sender-avatar">{senderName.slice(0,1).toUpperCase()}</div>
      <div className="reader-message-content">
        <div className="reader-message-meta"><div><strong>{senderName}</strong><span>&lt;{senderEmail}&gt;</span><small>{email.recipient.toLowerCase()===user.email.toLowerCase()?'to me':`to ${email.recipient}`} <ChevronDown size={11}/></small></div><time>{formatDate(date)}, {formatTime(date)}</time></div>
        {loading?<div className="reader-loading"><LoaderCircle className="spin" size={16}/>Loading message…</div>:hasHtml?<article className="reader-body reader-html" dangerouslySetInnerHTML={{__html:sanitizeEmailHtml(messageBody)}}/>:<article className="reader-body">{messageBody||'No message body available.'}</article>}
        {email.previewUrl&&<a className="reader-preview-link" href={email.previewUrl} target="_blank" rel="noreferrer">Open Ethereal preview <ArrowUpRight size={13}/></a>}
        {email.errorMessage&&<div className="form-error reader-error" role="alert">{email.errorMessage}</div>}
      </div>
    </section>
  </main>;
}

function sanitizeEmailHtml(html:string){
  const doc=new DOMParser().parseFromString(html,'text/html');
  doc.querySelectorAll('script,style,iframe,frame,object,embed,form,input,button,textarea,select,video,audio,svg,math,link,meta,base').forEach(node=>node.remove());
  doc.body.querySelectorAll('*').forEach(element=>{
    [...element.attributes].forEach(attribute=>{
      const name=attribute.name.toLowerCase();
      if(name.startsWith('on')||name==='style'||name==='srcdoc'||name==='srcset'||name==='formaction'){element.removeAttribute(attribute.name);return}
      if(name==='href'||name==='src'){
        const value=attribute.value.trim();
        const allowed=name==='href'?/^(https?:|mailto:)/i.test(value):/^https?:/i.test(value);
        if(!allowed)element.removeAttribute(attribute.name);
      }else if(!['alt','title','width','height','colspan','rowspan','align','cellpadding','cellspacing','border'].includes(name))element.removeAttribute(attribute.name);
    });
    if(element.tagName==='A'&&element.getAttribute('target')==='_blank')element.setAttribute('rel','noopener noreferrer');
  });
  return doc.body.innerHTML;
}
function DetailItem({label,value}:{label:string;value:ReactNode}){return <div className="detail-item"><span>{label}</span><strong>{value}</strong></div>}

function InfoIcon(){return <span className="info-symbol">i</span>}
function capitalize(value:string){return value.charAt(0).toUpperCase()+value.slice(1)}
function initials(name:string){return name.split(/\s+/).filter(Boolean).slice(0,2).map(part=>part[0]?.toUpperCase()).join('')||'R'}
function formatDate(value:string){const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:new Date().getFullYear()===date.getFullYear()?undefined:'numeric'}).format(date)}
function formatTime(value:string){const date=new Date(value);return Number.isNaN(date.getTime())?'':new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(date)}
