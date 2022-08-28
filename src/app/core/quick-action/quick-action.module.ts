import { AddTaskModule } from './../../todo/add-task/add-task.module';
import { MatIconModule } from '@angular/material/icon';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { QuickActionComponent } from './quick-action.component';

@NgModule({
  imports: [CommonModule, MatIconModule, AddTaskModule],
  declarations: [QuickActionComponent],
  exports: [QuickActionComponent]
})
export class QuickActionModule {}
