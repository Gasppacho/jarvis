import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { JournalComponent } from './journal.component';
import { JournalRoutes } from './journal.routing';
import { FormsModule } from '@angular/forms';
import { QuillModule } from 'ngx-quill';

@NgModule({
	imports: [CommonModule, JournalRoutes, FormsModule, QuillModule.forRoot()],
	declarations: [JournalComponent],
})
export class JournalModule {}
