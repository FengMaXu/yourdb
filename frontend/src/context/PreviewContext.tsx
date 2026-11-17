import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

export interface PreviewMessage {
    type: string;
    chartIndex?: number;
    dimension?: string;
    value?: string;
    chartTitle?: string;
    level?: number;
    targetLevel?: string;
}

type PreviewMessageHandler = (message: PreviewMessage) => void;

interface PreviewContextState {
    isOpen: boolean;
    url: string | null;
    title: string;
    fileType: string;
    openPreview: (url: string, title: string, fileType: string) => void;
    closePreview: () => void;
    emitPreviewMessage: (message: PreviewMessage) => void;
    subscribePreviewMessage: (handler: PreviewMessageHandler) => () => void;
}

const PreviewContext = createContext<PreviewContextState | undefined>(undefined);

export const PreviewProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [url, setUrl] = useState<string | null>(null);
    const [title, setTitle] = useState('');
    const [fileType, setFileType] = useState('');
    const messageHandlersRef = useRef(new Set<PreviewMessageHandler>());

    const openPreview = useCallback((nextUrl: string, nextTitle: string, nextFileType: string) => {
        setUrl(nextUrl);
        setTitle(nextTitle);
        setFileType(nextFileType);
        setIsOpen(true);
    }, []);

    const closePreview = useCallback(() => {
        setIsOpen(false);
        setUrl(null);
        setTitle('');
        setFileType('');
    }, []);

    const emitPreviewMessage = useCallback((message: PreviewMessage) => {
        messageHandlersRef.current.forEach((handler) => handler(message));
    }, []);

    const subscribePreviewMessage = useCallback((handler: PreviewMessageHandler) => {
        messageHandlersRef.current.add(handler);
        return () => {
            messageHandlersRef.current.delete(handler);
        };
    }, []);

    return (
        <PreviewContext.Provider
            value={{
                isOpen,
                url,
                title,
                fileType,
                openPreview,
                closePreview,
                emitPreviewMessage,
                subscribePreviewMessage,
            }}
        >
            {children}
        </PreviewContext.Provider>
    );
};

export const useOptionalPreview = (): PreviewContextState | undefined => useContext(PreviewContext);

export const usePreview = (): PreviewContextState => {
    const context = useContext(PreviewContext);
    if (!context) {
        throw new Error('usePreview must be used within a PreviewProvider');
    }
    return context;
};
