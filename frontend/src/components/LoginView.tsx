import React, { useEffect, useState } from 'react';
import { Loader2, LogIn, UserPlus } from 'lucide-react';
import { BrandWordmark } from './Brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '../hooks/useAuth';
import { useLanguage } from '../context/LanguageContext';

/** The brand's SQL voice, set beside the form: keyword, then value. */
const SQL_LINES = [
    ['SELECT', 'auth.sql.select'],
    ['FROM', 'auth.sql.from'],
    ['WHERE', 'auth.sql.where'],
] as const;

const FIELD = 'h-11 rounded-[11px] border-[#e2e0dc] bg-white px-3.5 text-[0.95rem] text-foreground md:text-[0.95rem] hover:border-[#d6d3d1] focus-visible:border-brand focus-visible:ring-4 focus-visible:ring-brand/15';
const ACTION = 'h-11 gap-2 rounded-[11px] text-[0.925rem] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand focus-visible:ring-0';

/** Sign-in: the brand's SQL voice on a dark panel, the form on paper. */
const LoginView: React.FC = () => {
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

    return (
        <main className="grid min-h-screen w-screen grid-cols-1 bg-[#fafaf9] min-[861px]:grid-cols-2">
            <aside className="relative isolate hidden flex-col justify-between gap-8 overflow-hidden bg-[#1c1917] px-12 py-10 text-[#e7e5e4] min-[861px]:flex" aria-hidden="true">
                {/* A faint grid, like ruled paper for numbers, and a warm glow in the corner. */}
                <div className="absolute inset-0 -z-10 bg-[linear-gradient(rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.045)_1px,transparent_1px)] bg-size-[32px_32px] mask-[radial-gradient(ellipse_at_30%_40%,#000_20%,transparent_75%)]" />
                <div className="absolute -right-[180px] -bottom-[220px] -z-10 size-[520px] rounded-full bg-[radial-gradient(circle,rgba(234,88,12,0.32),transparent_65%)] blur-[10px]" />
                <div className="flex items-center gap-2.5 font-mono text-xs text-[#a8a29e]">
                    <span className="inline-block size-[7px] rounded-full bg-[#ea580c] shadow-[0_0_0_4px_rgba(234,88,12,0.18)]" />
                    yourdb.sql
                </div>
                <pre className="m-0 grid gap-1.5 font-mono text-[clamp(1.15rem,1.9vw,1.6rem)] leading-normal whitespace-pre-wrap text-[#fafaf9]">
                    <span className="mb-2.5 animate-type-in text-[0.6em] text-[#78716c] motion-reduce:animate-none">-- {t('auth.sql.comment')}</span>
                    {SQL_LINES.map(([keyword, key], index) => (
                        <span
                            key={keyword}
                            className="animate-type-in [animation-delay:calc(160ms+var(--line)*140ms)] motion-reduce:animate-none"
                            style={{ '--line': index } as React.CSSProperties}
                        >
                            <b className="mr-[1.2ch] inline-block min-w-[5.2ch] font-semibold text-[#fb923c]">{keyword}</b>{t(key)}{index === SQL_LINES.length - 1 ? ';' : ''}
                        </span>
                    ))}
                    <span className="mt-0.5 h-[1.15em] w-[0.6ch] animate-blink bg-[#fb923c] motion-reduce:animate-none" />
                </pre>
                <p className="max-w-[34ch] text-sm leading-relaxed text-[#a8a29e]">{t('auth.tagline')}</p>
            </aside>
            <div className="grid place-items-center px-8 py-10">
                <form className="flex w-[min(360px,100%)] animate-rise flex-col gap-[18px] text-left motion-reduce:animate-none" onSubmit={handleSubmit}>
                    <div className="mb-2.5 flex flex-col gap-1.5">
                        <h1 className="mb-[18px] text-2xl leading-none text-foreground [&_.brand-wordmark]:h-[1.15em]"><BrandWordmark title="yourdb" /></h1>
                        <p className="text-[1.6rem] leading-tight font-[650] tracking-[-0.015em] text-foreground">{isRegister ? t('auth.registerTitle') : t('auth.loginTitle')}</p>
                        <p className="text-[0.9rem] text-muted-foreground">{isRegister ? t('auth.registerSubtitle') : t('auth.loginSubtitle')}</p>
                    </div>

                    <div className="flex flex-col gap-2">
                        <Label htmlFor="auth-username" className="text-[0.85rem] leading-normal font-semibold text-foreground">{t('auth.username')}</Label>
                        <Input
                            id="auth-username"
                            className={FIELD}
                            value={username}
                            onChange={(event) => setUsername(event.target.value)}
                            autoComplete="username"
                            autoFocus
                            spellCheck={false}
                            minLength={3}
                            required
                        />
                    </div>

                    <div className="flex flex-col gap-2">
                        <Label htmlFor="auth-password" className="text-[0.85rem] leading-normal font-semibold text-foreground">{t('auth.password')}</Label>
                        <Input
                            id="auth-password"
                            className={FIELD}
                            type="password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            autoComplete={isRegister ? 'new-password' : 'current-password'}
                            minLength={8}
                            required
                        />
                    </div>

                    {error && (
                        <div className="animate-rise-quick rounded-[10px] border border-[#fecaca] bg-[#fef2f2] px-3 py-2.5 text-[0.85rem] text-[#991b1b] motion-reduce:animate-none" role="alert" aria-live="assertive">
                            {error}
                        </div>
                    )}

                    <Button type="submit" disabled={submitting} className={`${ACTION} mt-1.5 bg-primary text-white shadow-[0_1px_2px_rgba(28,25,23,0.2),inset_0_1px_0_rgba(255,255,255,0.08)] hover:bg-[#292524] active:scale-[0.985] disabled:cursor-progress disabled:opacity-70 [&_svg:not([class*='size-'])]:size-[17px]`}>
                        {submitting ? <Loader2 className="animate-spin" /> : isRegister ? <UserPlus /> : <LogIn />}
                        <span>{submitting ? t('auth.submitting') : isRegister ? t('auth.createAccount') : t('auth.signIn')}</span>
                    </Button>

                    {registrationOpen && (
                        <Button
                            type="button"
                            variant="ghost"
                            className={`${ACTION} h-9 bg-transparent text-body hover:bg-transparent hover:text-foreground hover:underline hover:underline-offset-[3px]`}
                            onClick={() => setMode(isRegister ? 'login' : 'register')}
                        >
                            {isRegister ? t('auth.useExisting') : t('auth.createFirst')}
                        </Button>
                    )}
                </form>
            </div>
        </main>
    );
};

export default LoginView;
