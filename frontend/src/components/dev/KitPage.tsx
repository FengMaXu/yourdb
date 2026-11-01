import { useState } from 'react';
import { CheckCircle2, ChevronDown, Search, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { CodeBlock, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle, CodeBlockActions } from '@/components/ui/code-block';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Toaster } from '@/components/ui/sonner';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace';
import { toast } from 'sonner';

const SQL = `SELECT industry, SUM(sales_ytd) AS sales
FROM fact_sales_monthly
WHERE snapshot_month = '2025-12-01'
GROUP BY industry`;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="flex flex-col gap-3">
            <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
            <div className="flex flex-wrap items-start gap-3">{children}</div>
        </section>
    );
}

/**
 * Development-only page (/app/__kit): the shadcn/ui components on yourdb's theme, side by side.
 * It is the reference for tuning theme.css and for checking a component before a page adopts it.
 * Production builds leave it out (Root.tsx gates it on import.meta.env.DEV).
 */
export default function KitPage() {
    const [traceOpen, setTraceOpen] = useState(true);
    return (
        <TooltipProvider>
            <main className="mx-auto flex h-dvh max-w-4xl flex-col gap-8 overflow-y-auto bg-background p-8 text-foreground">
                <header className="flex items-center justify-between">
                    <h1 className="text-xl font-semibold">yourdb UI kit</h1>
                    <Badge variant="outline">dev only</Badge>
                </header>

                <Section title="Button">
                    <Button>Primary</Button>
                    <Button variant="secondary">Secondary</Button>
                    <Button variant="outline">Outline</Button>
                    <Button variant="ghost">Ghost</Button>
                    <Button variant="destructive">Delete</Button>
                    <Button variant="link">Link</Button>
                    <Button size="sm">Small</Button>
                    <Button disabled>Disabled</Button>
                </Section>

                <Section title="Badge">
                    <Badge>Default</Badge>
                    <Badge variant="secondary">Secondary</Badge>
                    <Badge variant="outline">Outline</Badge>
                    <Badge variant="destructive">Error</Badge>
                    <Badge className="bg-brand-soft text-brand">Brand</Badge>
                </Section>

                <Section title="Fields">
                    <div className="flex w-64 flex-col gap-2">
                        <Label htmlFor="kit-host">Host</Label>
                        <Input id="kit-host" placeholder="localhost" />
                    </div>
                    <div className="flex w-64 flex-col gap-2">
                        <Label htmlFor="kit-note">Note</Label>
                        <Textarea id="kit-note" placeholder="Write something" />
                    </div>
                    <div className="flex w-48 flex-col gap-2">
                        <Label>Driver</Label>
                        <Select defaultValue="mysql">
                            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="mysql">MySQL</SelectItem>
                                <SelectItem value="postgres">PostgreSQL</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="flex items-center gap-2">
                        <Switch id="kit-switch" defaultChecked />
                        <Label htmlFor="kit-switch">Enabled</Label>
                    </div>
                    <div className="flex items-center gap-2">
                        <Checkbox id="kit-check" defaultChecked />
                        <Label htmlFor="kit-check">Remember</Label>
                    </div>
                    <ToggleGroup defaultValue={['stdio']} variant="outline">
                        <ToggleGroupItem value="stdio">stdio</ToggleGroupItem>
                        <ToggleGroupItem value="http">HTTP</ToggleGroupItem>
                        <ToggleGroupItem value="sse">SSE</ToggleGroupItem>
                    </ToggleGroup>
                </Section>

                <Section title="Card and alert">
                    <Card className="w-80">
                        <CardHeader>
                            <CardTitle>Database</CardTitle>
                            <CardDescription>Where answers are queried from.</CardDescription>
                        </CardHeader>
                        <CardContent className="text-sm text-body">sales_demo on db.example:3306</CardContent>
                        <CardFooter className="justify-end gap-2">
                            <Button variant="outline" size="sm">Test</Button>
                            <Button size="sm">Save</Button>
                        </CardFooter>
                    </Card>
                    <div className="flex w-80 flex-col gap-3">
                        <Alert>
                            <CheckCircle2 />
                            <AlertTitle>Connected</AlertTitle>
                            <AlertDescription>The database answered in 12 ms.</AlertDescription>
                        </Alert>
                        <Alert variant="destructive">
                            <TriangleAlert />
                            <AlertTitle>Connection failed</AlertTitle>
                            <AlertDescription>Access denied for user visual.</AlertDescription>
                        </Alert>
                    </div>
                </Section>

                <Section title="Table">
                    <Table className="max-w-md">
                        <TableHeader>
                            <TableRow><TableHead>Industry</TableHead><TableHead className="text-right">Sales</TableHead></TableRow>
                        </TableHeader>
                        <TableBody>
                            <TableRow><TableCell>Wholesale</TableCell><TableCell className="text-right">6,710.25</TableCell></TableRow>
                            <TableRow><TableCell>Retail</TableCell><TableCell className="text-right">499.88</TableCell></TableRow>
                        </TableBody>
                    </Table>
                </Section>

                <Section title="Trace">
                    <Trace className="w-full max-w-md">
                        <TraceCollapsible open={traceOpen} onOpenChange={setTraceOpen}>
                            <TraceCollapsibleTrigger>
                                <TraceLine>
                                    <TraceIcon><Search /></TraceIcon>
                                    <TraceTitle>Processed for 16 s</TraceTitle>
                                    <ChevronDown className="size-3.5" />
                                </TraceLine>
                            </TraceCollapsibleTrigger>
                            <TraceCollapsibleContent>
                                <TraceLine><TraceTitle>search_knowledge</TraceTitle><TraceDescription>business.md</TraceDescription></TraceLine>
                                <TraceLine status="running"><TraceTitle>query_database</TraceTitle></TraceLine>
                                <TraceLine status="error"><TraceTitle>run_python</TraceTitle><TraceDescription>exit 1</TraceDescription></TraceLine>
                                <TraceLine status="pending"><TraceTitle>show_widget</TraceTitle></TraceLine>
                            </TraceCollapsibleContent>
                        </TraceCollapsible>
                    </Trace>
                </Section>

                <Section title="Code block">
                    <CodeBlock className="w-full max-w-xl">
                        <CodeBlockHeader>
                            <CodeBlockTitle>query.sql</CodeBlockTitle>
                            <CodeBlockActions><CodeBlockCopyButton value={SQL} /></CodeBlockActions>
                        </CodeBlockHeader>
                        <CodeBlockContent>{SQL.split('\n').map((line, index) => <CodeBlockLine key={index}>{line}</CodeBlockLine>)}</CodeBlockContent>
                    </CodeBlock>
                </Section>

                <Section title="Collapsible and tabs">
                    <Collapsible className="w-64 rounded-lg border p-3">
                        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>Show details</CollapsibleTrigger>
                        <CollapsibleContent className="pt-2 text-sm text-body">Hidden until opened.</CollapsibleContent>
                    </Collapsible>
                    <Tabs defaultValue="installed" className="w-64">
                        <TabsList>
                            <TabsTrigger value="installed">Installed</TabsTrigger>
                            <TabsTrigger value="settings">Settings</TabsTrigger>
                        </TabsList>
                        <TabsContent value="installed" className="text-sm text-body">Two plugins.</TabsContent>
                        <TabsContent value="settings" className="text-sm text-body">Plugin settings.</TabsContent>
                    </Tabs>
                </Section>

                <Section title="Overlays">
                    <Dialog>
                        <DialogTrigger render={<Button variant="outline" />}>Dialog</DialogTrigger>
                        <DialogContent>
                            <DialogHeader>
                                <DialogTitle>Delete session?</DialogTitle>
                                <DialogDescription>This cannot be undone.</DialogDescription>
                            </DialogHeader>
                            <DialogFooter><Button variant="destructive">Delete</Button></DialogFooter>
                        </DialogContent>
                    </Dialog>
                    <Sheet>
                        <SheetTrigger render={<Button variant="outline" />}>Sheet</SheetTrigger>
                        <SheetContent>
                            <SheetHeader>
                                <SheetTitle>Details</SheetTitle>
                                <SheetDescription>Tool calls of this answer.</SheetDescription>
                            </SheetHeader>
                        </SheetContent>
                    </Sheet>
                    <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="outline" />}>Menu</DropdownMenuTrigger>
                        <DropdownMenuContent>
                            <DropdownMenuItem>Rename</DropdownMenuItem>
                            <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <Tooltip>
                        <TooltipTrigger render={<Button variant="outline" />}>Tooltip</TooltipTrigger>
                        <TooltipContent>Copy to clipboard</TooltipContent>
                    </Tooltip>
                    <Button variant="outline" onClick={() => toast.success('Saved')}>Toast</Button>
                </Section>
                <Toaster />
            </main>
        </TooltipProvider>
    );
}
