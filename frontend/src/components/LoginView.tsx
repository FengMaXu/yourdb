import React, { useEffect, useState } from 'react';
import { BrandWordmark } from './Brand';
import { LogIn, UserPlus, Loader2 } from './icons/Typicons';
import { useAuth } from '../hooks/useAuth';
import { useLanguage } from '../context/LanguageContext';

interface LoginViewProps {
    embedded?: boolean;
}

/** The brand's SQL voice, set beside the form: keyword, then value. */
const SQL_LINES = [
    ['SELECT', 'auth.sql.select'],
    ['FROM', 'auth.sql.from'],
    ['WHERE', 'auth.sql.where'],
] as const;

const LoginView: React.FC<LoginViewProps> = ({ embedded = false }) => {
    const { login, register, registrationOpen } = useAuth();
    const { t } = useLanguage();
    const [mode, setMode] = useState<'login' | 'register'>(registrationOpen ? 'register' : 'login');

    // registrationOpen arrives asynchronously from /auth/status; flip to the
    // register form when this host is waiting for its first account.
    useEffect(() => {
        if (registrationOpen) setMode('register');
    }, [registrationOpen]);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const isRegister = mode === 'register';

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setSubmitting(true);
        setError('');
        try {
            if (isRegister) {
                await register(username, password, username);
            } else {
                await login(username, password);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('auth.errorFallback'));
        } finally {
            setSubmitting(false);
        }
    };

    const form = (
            <form className={`auth-panel ${embedded ? 'auth-panel-embedded' : ''}`} onSubmit={handleSubmit}>
                <div className="auth-brand">
                    <h1><BrandWordmark title="yourdb" /></h1>
                    <p className="auth-heading">{isRegister ? t('auth.registerTitle') : t('auth.loginTitle')}</p>
                    <p className="auth-sub">{isRegister ? t('auth.registerSubtitle') : t('auth.loginSubtitle')}</p>
                </div>

                <label className="auth-field">
                    <span>{t('auth.username')}</span>
                    <input
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        autoComplete="username"
                        autoFocus
                        spellCheck={false}
                        minLength={3}
                        required
                    />
                </label>

                <label className="auth-field">
                    <span>{t('auth.password')}</span>
                    <input
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete={isRegister ? 'new-password' : 'current-password'}
                        minLength={8}
                        required
                    />
                </label>

                {error && <div className="auth-error" role="alert" aria-live="assertive">{error}</div>}

                <button className="auth-submit" type="submit" disabled={submitting}>
                    {submitting ? <Loader2 size={17} className="animate-spin" /> : isRegister ? <UserPlus size={17} /> : <LogIn size={17} />}
                    <span>{submitting ? t('auth.submitting') : isRegister ? t('auth.createAccount') : t('auth.signIn')}</span>
                </button>

                {registrationOpen && (
                    <button
                        className="auth-mode-toggle"
                        type="button"
                        onClick={() => setMode(isRegister ? 'login' : 'register')}
                    >
                        {isRegister ? t('auth.useExisting') : t('auth.createFirst')}
                    </button>
                )}
            </form>
    );

    if (embedded) {
        return form;
    }

    return (
        <main className="auth-shell">
            <aside className="auth-aside" aria-hidden="true">
                <div className="auth-aside-file">yourdb.sql</div>
                <pre className="auth-sql">
                    <span className="auth-sql-comment">-- {t('auth.sql.comment')}</span>
                    {SQL_LINES.map(([keyword, key], index) => (
                        <span key={keyword} className="auth-sql-line" style={{ '--line': index } as React.CSSProperties}>
                            <b>{keyword}</b>{t(key)}{index === SQL_LINES.length - 1 ? ';' : ''}
                        </span>
                    ))}
                    <span className="auth-sql-cursor" />
                </pre>
                <p className="auth-aside-foot">{t('auth.tagline')}</p>
            </aside>
            <div className="auth-main">
                {form}
            </div>
        </main>
    );
};

export default LoginView;
