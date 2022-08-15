import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { QuickActionComponent } from './quick-action.component';

@NgModule({
	imports: [
		CommonModule
	],
	declarations: [QuickActionComponent],
	exports: [QuickActionComponent]
})
export class QuickActionModule { }
