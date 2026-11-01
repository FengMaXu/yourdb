import React from 'react';
import {
    FileSpreadsheet,
    FileCode,
    Image,
    FileText,
    File as BaseFileIcon,
} from 'lucide-react';

interface FileIconProps {
    filename: string;
    size?: number;
    className?: string;
}

const FileIconComponent: React.FC<FileIconProps> = ({ filename, size = 18, className = '' }) => {
    const ext = filename.split('.').pop()?.toLowerCase() || '';

    const icons: Record<string, React.ElementType> = {
        csv: FileSpreadsheet,
        xlsx: FileSpreadsheet,
        xls: FileSpreadsheet,
        py: FileCode,
        js: FileCode,
        ts: FileCode,
        json: FileCode,
        png: Image,
        jpg: Image,
        jpeg: Image,
        gif: Image,
        svg: Image,
        txt: FileText,
        md: FileText,
        log: FileText,
    };

    const Icon = icons[ext] || BaseFileIcon;
    return <Icon size={size} className={className} />;
};

export const FileIcon = FileIconComponent;
