import { Id } from '../../util/Id';
import { EOperation } from "./e-operation";
import { IContainer } from '../../model/IContainer';
import { SpecmateDataService } from "../data/specmate-data.service";
import { Objects } from "../../util/Objects";
import { Command } from "./command";
import { Arrays } from "../../util/Arrays";
import { LoggingService } from "../logging/logging.service";

export class Scheduler {

    private commands: Command[] = [];

    constructor(private dataService: SpecmateDataService, private logger: LoggingService) { }

    public commit(): Promise<void> {
        return this.chainCommits().then(() => {
            this.clearCommits();
        });
    }

    private get unresolvedCommands(): Command[] {
        return this.commands.filter((command: Command) => !command.isResolved);
    }

    private get lastCommand(): Command {
        return this.unresolvedCommands[this.unresolvedCommands.length - 1];
    }

    private popCommand(): Command {
        let index: number = this.commands.indexOf(this.lastCommand);
        let command: Command = this.commands[index];
        this.commands.splice(index, 1);
        return command;
    }

    private popCompoundCommands(): Command[] {
        let lastCommand: Command = this.lastCommand;
        let compoundId: string = lastCommand.compoundId;
        let unresolvedCompoundCommands: Command[] = this.unresolvedCommands.filter((command: Command) => command.compoundId === lastCommand.compoundId);
        for(let i = unresolvedCompoundCommands.length - 1; i >= 0; i--) {
            let index: number = this.commands.indexOf(unresolvedCompoundCommands[i]);
            this.commands.splice(index, 1);
        }
        return unresolvedCompoundCommands;
}

    private getInitialValue(url: string): IContainer {
        let initCommand: Command = this.commands.filter((command: Command) => command.operation === EOperation.INIT && command.originalValue.url === url)[0];
        
        if(initCommand) {
            return initCommand.originalValue;
        }

        return undefined;
    }

    public undo(): void {
        let lastCommands: Command[] = this.popCompoundCommands();
        
        if(!lastCommands || lastCommands.length < 1) {
            this.logger.warn('No commands left.');
            return;
        }
        
        lastCommands.reverse().forEach((command: Command) => this.undoSingleCommand(command));
    }

    private undoSingleCommand(command: Command): void {
        if(!command) {
            this.logger.warn('Command was not defined.');
            return;
        }
        let originalValue: IContainer = command.originalValue;
        
        // First, we check whether this element was initialized (this happens, if it was read from the server)
        if(!originalValue) {
            originalValue = this.getInitialValue(command.url);
        }

        switch (command.operation) {
            case EOperation.CREATE:
                this.dataService.undoCreate(command.newValue.url);
                break;
            case EOperation.UPDATE:
                this.dataService.undoUpdate(originalValue);
                break;
            case EOperation.DELETE:
                this.dataService.undoDelete(originalValue);
                break;
            default:
                break;
        }
    }

    public clearCommits(): void {
        this.commands = this.commands.filter((command: Command) => command.operation === EOperation.INIT || command.isResolved);
    }

    public get hasCommits(): boolean {
        return this.countOpenCommits > 0;
    }

    public get countOpenCommits(): number {
        return this.unresolvedCommands.length;
    }

    private chainCommits(): Promise<void> {
        let chain: Promise<void> = Promise.resolve();
        let unresolvedCommands: Command[] = this.unresolvedCommands;
        for(let i = 0; i < unresolvedCommands.length; i++) {
            chain = chain.then(() => {
                return this.dataService.getPromiseForCommand(unresolvedCommands[i]);
            });
        }
        return chain;
    }

    private getCommands(url: string): Command[] {
        return this.commands.filter((command: Command) => command.url === url);
    }

    private getLastStoredValue(url: string): IContainer {
        let commands: Command[] = this.getCommands(url);
        if(commands && commands.length > 0) {
            return commands[commands.length - 1].newValue;
        }
        return undefined;
    }

    private getFirstUnresolvedCommand(url: string): Command {
        return this.unresolvedCommands.filter((command: Command) => command.url === url)[0];
    }

    private getLastUnresolvedCommand(url?: string): Command {
        if(!url) {
            return this.unresolvedCommands[this.unresolvedCommands.length - 1];
        }
        let commandsForUrl: Command[] = this.unresolvedCommands.filter((command: Command) => command.url === url);
        return commandsForUrl[commandsForUrl.length - 1];
    }

    public initElement(element: IContainer): void {
        if(!element) {
            return;
        }
        if(this.shouldInit(element.url)) {
            let command: Command = new Command(element.url, element, element, EOperation.INIT, Id.uuid);
            this.commands.push(command);
        }
    }

    private shouldInit(url: string): boolean {
        return !this.commands.some((command: Command) => command.operation === EOperation.INIT && command.url === url);
    }

    public schedule(url: string, operation: EOperation, newValue: IContainer, originalValue: IContainer, compoundId: string): void {
        if(!originalValue) {
            originalValue = this.getLastStoredValue(url);
        }

        let command: Command = new Command(url, originalValue, newValue, operation, compoundId);

        switch(command.operation) {
            case EOperation.CREATE:
                this.scheduleCreateCommand(command);
            break;
            case EOperation.UPDATE:
                this.scheduleUpdateCommand(command);
            break;
            case EOperation.DELETE:
                this.scheduleDeleteCommand(command);
            break;
        }
    }

    private unScheduleLastCommand(url: string): boolean {
        let index: number = this.commands.indexOf(this.getLastUnresolvedCommand(url));
        if(index >= 0) {
            this.commands.splice(index, 1);
            return true;
        }
        return false;
    }

    private unScheduleAllCommands(url: string) {
        let unscheduled: boolean = true;
        while(unscheduled) {
            unscheduled = this.unScheduleLastCommand(url);
        }
    }

    private scheduleCreateCommand(command: Command) {
        this.commands.push(command);
    }

    private scheduleUpdateCommand(command: Command): void {
        if(!command.originalValue) {
            return;
        }
        if(!this.currentlyExists(command.url)) {
            return;
        }
        let lastCommand: Command = this.getLastUnresolvedCommand();
        if(this.shouldMerge(lastCommand, command)) {
            command = lastCommand.mergeKeepOriginalValue(command);
            this.unScheduleLastCommand(command.url);
        }
        if(command.isDifference) {
            this.commands.push(command);
        }
    }

    private scheduleDeleteCommand(command: Command): void {
        if(!this.currentlyExists(command.url)) {
            return;
        }
        this.commands.push(command);
    }

    private currentlyExists(url: string): boolean {
        let commands: Command[] = this.getCommands(url);
        if(commands.length == 0) {
            this.logger.error('Tried to check existence of unknown element!', url);
            throw new Error("Tried to check existence for unknown element! " + url);
        }
        let lastCommand: Command = commands[commands.length - 1];
        return lastCommand.operation !== EOperation.DELETE;
    }

    private shouldMerge(c1: Command, c2: Command): boolean {
        if(c1 && c2) {
            return c1.operation === EOperation.UPDATE && c2.operation === EOperation.UPDATE && c1.changedSameFields(c2) && c1.url === c2.url;
        }
        return false;
    }

    public isVirtualElement(url: string): boolean {
        return this.getCommands(url).some((command: Command) => command.operation === EOperation.CREATE && !command.isResolved);
    }

    public resolve(url: string): void {
        this.logger.debug('Resolve', url);
        let firstCommand: Command = this.getFirstUnresolvedCommand(url);
        if(firstCommand) {
            firstCommand.resolve();
            return;
        }
        this.logger.error('Command not found for resolve', url);
        throw new Error('Tried to resolve ' + url + ', but no command was found.');
    }

}