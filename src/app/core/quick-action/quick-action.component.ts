import { Component, OnInit } from '@angular/core';

@Component({
  selector: 'jarvis-quick-action',
  templateUrl: './quick-action.component.html',
  styleUrls: ['./quick-action.component.less']
})
export class QuickActionComponent implements OnInit {
  isPrintAddTask: boolean = false;

  constructor() {}

  ngOnInit() {}

  showAddTask(): void {
    this.isPrintAddTask = true;
  }

  closeAddTask(): void {
    this.isPrintAddTask = false;
  }
}
