import { useState } from "react";
import { Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { trpc } from "@/lib/trpc";

export default function LoginScreen() {
  const utils = trpc.useUtils();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const login = trpc.appAuth.login.useMutation({
    onSuccess: () => utils.appAuth.session.invalidate(),
  });

  return (
    <div className="login-shell">
      <form
        className="login-card"
        onSubmit={event => {
          event.preventDefault();
          if (password) login.mutate({ password });
        }}
      >
        <div className="login-brand">
          <div className="app-mark" aria-hidden="true"><span className="app-mark-core">S</span><span className="app-mark-pulse" /></div>
          <div>
            <div className="brand-name">solscreen</div>
            <div className="brand-caption">INTELIJEN TOKEN</div>
          </div>
        </div>
        <h1 className="login-title">Masuk ke dashboard</h1>
        <p className="login-copy">Masukkan password aplikasi untuk melanjutkan.</p>

        <label className="login-label" htmlFor="app-password">Password</label>
        <div className={`login-input ${login.error ? "invalid" : ""}`}>
          <Lock size={15} />
          <input
            id="app-password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={event => { setPassword(event.target.value); login.reset(); }}
            aria-invalid={Boolean(login.error)}
            aria-describedby="login-error"
          />
          <button type="button" className="mini-copy" onClick={() => setShow(v => !v)} aria-label={show ? "Sembunyikan password" : "Tampilkan password"}>
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
        <div id="login-error" className="field-error" role="alert">{login.error?.message ?? ""}</div>

        <button type="submit" className="primary-button login-submit" disabled={!password || login.isPending}>
          {login.isPending && <Loader2 size={15} className="spin" />} Masuk
        </button>
      </form>
    </div>
  );
}
